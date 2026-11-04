import { decodeClaudeTranscriptLine } from '../native-chat/transcript-line-decoders-claude'
import { claudeEnvelopeStopHookFeedbackRow } from './claude-stop-hook-feedback'
import {
  claudeRecord,
  type ClaudeMessageEnvelope
} from './structured/journal/claude-structured-item-translation'

export function claudeTranscriptPrompt(
  row: Record<string, unknown>,
  envelope: ClaudeMessageEnvelope | null,
  providerSessionId: string
) {
  const candidate =
    row.type === 'attachment' ||
    (envelope?.role === 'user' &&
      !claudeEnvelopeStopHookFeedbackRow(envelope) &&
      envelope.content.some((part) => claudeRecord(part)?.type !== 'tool_result'))
  const decodedPrompt = candidate
    ? decodeClaudeTranscriptLine(JSON.stringify(row), `${providerSessionId}:${String(row.uuid)}`)
    : null
  const prompt =
    candidate &&
    (!envelope?.isInjectedUserTurn ||
      decodedPrompt?.blocks.some((block) => block.type !== 'tool-result'))
  const decoded = prompt ? decodedPrompt : null
  // A stop marker restates the chat's own interrupted turn, which its turn row already reads.
  return { decoded, ignored: prompt && (!decoded || decoded.role === 'system') }
}
