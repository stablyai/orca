import { connectorCopy } from './connector-copy.js'

// What the agent reads: mentions of the bot (<@id>, or the older <@!id>) dropped.
export function discordPromptText(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim()
}

// Inputs we interpolate (machine and project names, reasons) can't format text or forge a masked
// link; agent text is posted as written, and allowed_mentions keeps it from pinging anyone.
export function escapeDiscordText(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#<]/g, '\\$&')
}

// Discord's limits on a message's content and a button's label.
export const MAX_DISCORD_CONTENT_CHARS = 2_000
export const MAX_DISCORD_LABEL_CHARS = 80

export const discordText = connectorCopy({
  appName: 'Discord',
  escape: escapeDiscordText,
  bold: (text) => `**${text}**`,
  maxCardChars: MAX_DISCORD_CONTENT_CHARS,
  maxButtonLabelChars: MAX_DISCORD_LABEL_CHARS
})
