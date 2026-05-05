import type { MessageRow } from './types'

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

// Why: rich message banners help agents (and humans reading terminal output)
// quickly parse message metadata. Priority indicators surface urgent messages
// visually. The reply hint reduces friction for agent-to-agent responses
// (Section 4.8).
export function formatMessageBanner(msg: MessageRow): string {
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : ''
  const senderName = msg.from_handle.toUpperCase()

  const header = `──── From: ${senderName} (${msg.from_handle})${priorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${msg.subject}`)

  if (msg.body) {
    lines.push(msg.body)
  }

  if (msg.payload) {
    lines.push(`[Payload: ${msg.payload}]`)
  }

  lines.push(`[Reply: orca orchestration reply --id ${msg.id} --body "..."]`)
  lines.push(SEPARATOR)

  return lines.join('\n')
}

// Why: grouping multiple banners under a single wrapper line lets agents detect
// the message block boundary and parse each banner individually.
export function formatMessagesForInjection(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }

  const banners = messages.map(formatMessageBanner).join('\n\n')
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`
}
