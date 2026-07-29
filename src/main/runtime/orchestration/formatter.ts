import type { MessageRow } from './types'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

export function formatMessageBanner(msg: MessageRow): string {
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : ''
  const legacyReadOnly = msg.run_id === ORCHESTRATION_LEGACY_RUN_ID
  const authorityTag = legacyReadOnly ? ' [LEGACY READ-ONLY]' : ''
  const senderName = msg.from_handle.toUpperCase()

  const header = `──── From: ${senderName} (${msg.from_handle})${priorityTag}${authorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${msg.subject}`)
  if (legacyReadOnly) {
    lines.push('[Inspection only: reply and acknowledgment are unavailable.]')
  }

  if (msg.body) {
    lines.push(msg.body)
  }

  if (msg.payload) {
    lines.push(`[Payload: ${msg.payload}]`)
  }

  if (!legacyReadOnly) {
    // Why: older shells can lack Orca's terminal identity environment.
    lines.push(
      `[Reply: orca orchestration reply --id ${msg.id} --from ${msg.to_handle} --body "..."]`
    )
  }
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
