import { isClaudeToolResultContent } from '../../../shared/claude-tool-content'
import { decodeClaudeTranscriptLine } from '../../native-chat/transcript-line-decoders-claude'
import { claudeEnvelopeStopHookFeedbackRow } from '../structured/journal/claude-stop-hook-feedback'
import {
  claudeRecord,
  claudeOutputEnvelope,
  type ClaudeMessageEnvelope
} from '../structured/journal/claude-structured-item-translation'

export function claudeTranscriptPrompt(
  row: Record<string, unknown>,
  envelope: ClaudeMessageEnvelope | null,
  providerSessionId: string
) {
  const feedback = envelope && claudeEnvelopeStopHookFeedbackRow(envelope)
  const candidate =
    row.type === 'attachment' ||
    (envelope?.role === 'user' &&
      !feedback &&
      envelope.content.some((part) => !isClaudeToolResultContent(part)))
  const decodedPrompt = candidate
    ? decodeClaudeTranscriptLine(JSON.stringify(row), `${providerSessionId}:${String(row.uuid)}`)
    : null
  const prompt =
    candidate &&
    (!envelope?.isInjectedUserTurn ||
      decodedPrompt?.blocks.some((block) => block.type !== 'tool-result'))
  const decoded = prompt ? decodedPrompt : null
  // A stop marker restates the chat's own interrupted turn, which its turn row already reads.
  return {
    decoded,
    ignored: prompt && (!decoded || decoded.role === 'system'),
    internalTurnStart:
      candidate &&
      row.type === 'user' &&
      claudeRecord(row.origin)?.kind === 'task-notification' &&
      row.isMeta !== true &&
      row.isSynthetic !== true &&
      row.isCompactSummary !== true,
    hasWork: Boolean(envelope && (claudeOutputEnvelope(envelope).content.length || feedback))
  }
}
