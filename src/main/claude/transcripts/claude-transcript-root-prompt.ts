import { claudeTranscriptPrompt } from './claude-transcript-prompt'
import { readClaudeMessageEnvelope } from '../structured/journal/claude-structured-item-translation'

/** Attachments/queued steer and tool results continue the existing root. */
export function isClaudeTranscriptRootPrompt(row: Record<string, unknown>): boolean {
  if (row.type !== 'user' || row.isSidechain === true || row.parent_tool_use_id != null) {
    return false
  }
  const envelope = readClaudeMessageEnvelope({
    ...row,
    session_id: row.sessionId,
    parent_tool_use_id: null
  })
  const { decoded, ignored, internalTurnStart } = claudeTranscriptPrompt(
    row,
    envelope,
    String(row.sessionId)
  )
  return !ignored && (internalTurnStart || decoded?.role === 'user')
}
