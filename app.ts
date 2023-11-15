import * as web3 from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const airdropSol = async(wallet: web3.Keypair, connection: web3.Connection) => {
    const airdropSignature = await connection.requestAirdrop(
        wallet.publicKey,
        web3.LAMPORTS_PER_SOL * 2
    )

    const latestBlockHash = await connection.getLatestBlockhash()

    await connection.confirmTransaction(
        {
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: airdropSignature,
        },
        "finalized"
    )

    const newBalance = await connection.getBalance(wallet.publicKey)
    console.log(`New balance of ${wallet.publicKey} is ${newBalance / web3.LAMPORTS_PER_SOL}`)
}

const createNewGiveaway = async(connection: web3.Connection) => {
    // Generate our giveaway wallet which we will use to mint tokens
    const giveaway_wallet = web3.Keypair.generate() 
    // Airdrop some sol into our giveaway wallet
    await airdropSol(giveaway_wallet, connection); 

    // Create our token's mint account
    const giveaway_token = await createMint(
        connection,
        giveaway_wallet,
        giveaway_wallet.publicKey,
        giveaway_wallet.publicKey,
        0
    );

    console.log(`Created giveaway token, mint address: ${giveaway_token.toBase58()}`)

    // Create token account for giveaway wallet
    const giveaway_token_account = await getOrCreateAssociatedTokenAccount(
        connection,
        giveaway_wallet,
        giveaway_token,
        giveaway_wallet.publicKey
    )

    // Mint 500 tokens to our giveaway token account
    await mintTo(
        connection,
        giveaway_wallet,
        giveaway_token,
        giveaway_token_account.address,
        giveaway_wallet.publicKey,
        500
    )
    
    return {giveaway_wallet, giveaway_token, giveaway_token_account}
}

const sendV0Transaction = async(connection: web3.Connection, payer: web3.Keypair, instructions: web3.TransactionInstruction[], lookupTableAccounts?: web3.AddressLookupTableAccount[]) => {
    // Get the last valid block height and blockhash
    const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash();

    // Create the V0 message to pass to Versioned Transaction
    const messageV0 = new web3.TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message(lookupTableAccounts);

    // Generate Versioned Transaction from V0 message
    const transaction = new web3.VersionedTransaction(messageV0);

    // Sign the transaction with payer
    transaction.sign([payer]);

    // Send the transaction and get transaction id
    const txid = await connection.sendTransaction(transaction);

    // Confirm the transaction using blockhash, last valid block height and signature
    await connection.confirmTransaction(
        {
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            signature: txid,
        },
        "finalized",
    );

    console.log(`Transaction id: ${txid}`)

    // Return the serialized transaction to later compare transaction sizes
    return transaction.serialize()
}

const waitForNewBlock = async(connection: web3.Connection, targetHeight: number) => {
    console.log(`Waiting for ${targetHeight} new blocks`);
    return new Promise(async (resolve: any) => {
        // Get the last valid block height
        const { lastValidBlockHeight } = await connection.getLatestBlockhash();

        // Check if at least targetHeight amount of new blocks are generated every 1 second
        const intervalId = setInterval(async () => {
            const { lastValidBlockHeight: newValidBlockHeight } =
                await connection.getLatestBlockhash();

            if (newValidBlockHeight > lastValidBlockHeight + targetHeight) {
                clearInterval(intervalId);
                resolve();
            }
        }, 1000);
    });
}

const initLookupTable = async(connection: web3.Connection, payer: web3.Keypair, addresses: web3.PublicKey[]) => {
    const currentSlot = await connection.getSlot();
    // Get a list of recent slots
    const slots = await connection.getBlocks(currentSlot - 200);

    // Generate the instruction for creating a lookup table
    const [lookupTableInstruction, lookupTableAddress] =
        web3.AddressLookupTableProgram.createLookupTable({
            authority: payer.publicKey,
            payer: payer.publicKey,
            recentSlot: slots[0],
    });

    // Generate the instruction for extending the lookup table
    const extendInstruction = web3.AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: addresses,
    });

    // Send instructions using our helper function
    await sendV0Transaction(connection, payer, [lookupTableInstruction, extendInstruction])

    console.log(`Created and extended the lookup table, address: ${lookupTableAddress}`)
    return lookupTableAddress
}

const main = async() => {
    // Create an array to keep track of accounts that we want to store in ALT
    let addresses: web3.PublicKey[] = []

    // Set the connection to localhost
    const connection = new web3.Connection("http://127.0.0.1:8899");
    const {giveaway_wallet, giveaway_token, giveaway_token_account} = await createNewGiveaway(connection)

    // Add our giveaway accounts to addresses
    addresses.push(giveaway_wallet.publicKey, giveaway_token, giveaway_token_account.address)

    // Generate 20 unique public keys for each participant
    let participants = []
    for (let index = 0; index < 20; index++) {
        participants.push(web3.Keypair.generate().publicKey);
    }

    // Shuffle participants and select 5 random winners
    const shuffled = participants.sort(() => 0.5 - Math.random());
    let winners = shuffled.slice(0, 10);

    // Create token sending instrction for each winner
    let instructions: web3.TransactionInstruction[] = []
    for(let index = 0; index < winners.length; index++) {
        const to_token_account = await getOrCreateAssociatedTokenAccount(
            connection,
            giveaway_wallet,
            giveaway_token,
            winners[index],
        );

        // Don't forget to add winner's token account to addresses
        addresses.push(to_token_account.address)

        // Instruction for sending 2 tokens to each winner
        instructions.push(
            createTransferInstruction(
                giveaway_token_account.address,
                to_token_account.address,
                giveaway_wallet.publicKey,
                2,
                [giveaway_wallet],
                TOKEN_PROGRAM_ID
        ))
    }
    
    // Initialize lookup table with given addresses
    const lookupTableAddress = await initLookupTable(connection, giveaway_wallet, addresses)

    // Wait for one block to get lookup table account
    await waitForNewBlock(connection, 1)

    // Get lookup table account
    const lookupTableAccount = (await connection.getAddressLookupTable(lookupTableAddress)).value;

    if (!lookupTableAccount) { 
        console.log("Couldn't find the lookup table")
        return; 
    }
    
    // Send our instructions to Versioned Transaction with the lookup table 
    const serializedTxWithTable = await sendV0Transaction(connection, giveaway_wallet, instructions, [lookupTableAccount]);
    console.log(`Transferring tokens with ALT: ${serializedTxWithTable.length} bytes`)

    // Send our instructions to Versioned Transaction without the lookup table 
    const serializedTxWithoutTable = await sendV0Transaction(connection, giveaway_wallet, instructions);
    console.log(`Transferring tokens without ALT: ${serializedTxWithoutTable.length} bytes`)
}

main()