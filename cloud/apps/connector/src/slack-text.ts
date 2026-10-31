import { connectorCopy } from './connector-copy.js'

// Slack's three escapes: text from an agent or a machine name can't ping a channel or forge a link.
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// Slack's limits on a button's label and a section's text.
export const MAX_BUTTON_LABEL_CHARS = 75

export const slackText = connectorCopy({
  appName: 'Slack',
  escape: escapeSlackText,
  bold: (text) => `*${text}*`,
  maxCardChars: 3_000,
  maxButtonLabelChars: MAX_BUTTON_LABEL_CHARS
})
