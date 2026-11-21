import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { extractAntigravityUserRequest } from '../../../shared/agent-hook-listener/transcript-lines'
import { decodeAntigravityStepIndex } from '../../../shared/agent-hook-listener/providers/antigravity/antigravity-step-index'
import { extractString } from '../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { timestampMs } from '../../ai-vault/parsing/session-record-time'

/** One agy transcript step as chat history: the person's request or the model's reply text.
 *  Tool steps, system notices and checkpoints stay in agy's own conversation, which the chat
 *  resumes, so only the conversation's words are shown. */
export function decodeAntigravityTranscriptLine(
  line: string
): { recordId: string; message: NativeChatMessage } | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  // Some agy builds write the step index as a string.
  const step = record.step_index
  const index = decodeAntigravityStepIndex(step)
  if (index === undefined) {
    return null
  }
  const source = extractString(record.source)
  const type = extractString(record.type)
  const content = typeof record.content === 'string' ? record.content : ''
  const parsedTime = timestampMs(record.created_at)
  const timestamp = Number.isFinite(parsedTime) ? parsedTime : null
  const recordId = `step:${typeof step === 'string' ? step : index}`
  if (
    (source === 'USER_EXPLICIT' || source === 'USER') &&
    (type === 'USER_INPUT' || type === 'REQUEST')
  ) {
    const text = extractAntigravityUserRequest(content)
    return text
      ? {
          recordId,
          message: {
            id: recordId,
            role: 'user',
            blocks: [{ type: 'text', text }],
            timestamp,
            source: 'transcript'
          }
        }
      : null
  }
  if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content.trim()) {
    const model = extractString(record.model)
    return {
      recordId,
      message: {
        id: recordId,
        role: 'assistant',
        blocks: [{ type: 'text', text: content }],
        timestamp,
        source: 'transcript',
        ...(model ? { model } : {})
      }
    }
  }
  return null
}
