// Placeholder: replace with the official Orca Discord Application client ID
// after creating the app at https://discord.com/developers/applications
// and uploading the 'orca' asset (logo).
const rawClientId = process.env.ORCA_DISCORD_CLIENT_ID ?? '000000000000000000'
console.log('[discord-presence] client_id:', rawClientId === '000000000000000000' ? 'PLACEHOLDER' : 'set')
export const DISCORD_RICH_PRESENCE_CLIENT_ID = rawClientId

export const DISCORD_RICH_PRESENCE_ASSET_KEY = 'orca'