import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import { claudeText } from './claude-structured-item-translation'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

export function claudeCompactionIdentity(
  message: Record<string, unknown>
): AgentJournalItemIdentity | null {
  const sessionId = claudeText(message.session_id)
  const uuid = claudeText(message.uuid)
  return message.type === 'system' &&
    message.subtype === 'compact_boundary' &&
    isRootClaudeFrame(message) &&
    sessionId &&
    uuid
    ? { provider: 'claude', sessionId, uuid }
    : null
}

export function journalClaudeCompaction(
  { sink, turn }: Pick<ClaudeMessageJournalContext, 'sink' | 'turn'>,
  message: Record<string, unknown>,
  observedAt: number
): boolean {
  if (message.type !== 'system' || message.subtype !== 'compact_boundary') {
    return false
  }
  // Commands already publish their confirmed result; child compaction does not replace root history.
  if (turn.command || !isRootClaudeFrame(message)) {
    return true
  }
  const identity = claudeCompactionIdentity(message)
  if (identity) {
    // The boundary UUID upserts the same durable row on duplicate delivery or resume.
    sink.appendItem(
      identity,
      { kind: 'status', text: 'Context compacted', presentation: 'compaction' },
      { turnScope: turn.turnScope, observedAt, lifecycle: true }
    )
    sink.publish()
  }
  return true
}
