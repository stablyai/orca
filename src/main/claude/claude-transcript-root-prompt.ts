import { decodeClaudeTranscriptLine } from '../native-chat/transcript-line-decoders-claude'
import { claudeEnvelopeStopHookFeedbackRow } from './claude-stop-hook-feedback'
import {
  claudeRecord,
  readClaudeMessageEnvelope
} from './structured/journal/claude-structured-item-translation'

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
  if (
    !envelope ||
    claudeEnvelopeStopHookFeedbackRow(envelope) ||
    !envelope.content.some((part) => claudeRecord(part)?.type !== 'tool_result')
  ) {
    return false
  }
  return decodeClaudeTranscriptLine(JSON.stringify(row), String(row.uuid))?.role === 'user'
}
