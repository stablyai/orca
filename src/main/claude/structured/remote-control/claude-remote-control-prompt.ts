import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  claudeMessageBody,
  claudeRecord,
  type ClaudeMessageEnvelope
} from '../journal/claude-structured-item-translation'

/** Claude stamps a person's prompt from its own apps with a human origin; Orca's sends carry none,
 *  and Claude's own injected turns name other origins. */
export function isClaudeRemoteControlPromptFrame(frame: Record<string, unknown>): boolean {
  return claudeRecord(frame.origin)?.kind === 'human'
}

/** The row for a prompt the person sent over Remote Control, which no Orca submission owns. */
export function claudeRemoteControlPromptBody(
  envelope: ClaudeMessageEnvelope,
  frame: Record<string, unknown>,
  clientMessageId: string | undefined
): AgentJournalMessageItem | null {
  if (
    envelope.role !== 'user' ||
    clientMessageId !== undefined ||
    envelope.parentToolUseId !== null ||
    envelope.isInjectedUserTurn ||
    !isClaudeRemoteControlPromptFrame(frame)
  ) {
    return null
  }
  const body = claudeMessageBody(envelope)
  return body ? { ...body, sentFrom: 'provider-remote-control' } : null
}
