import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { extractString } from '../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { timestampMs } from '../../ai-vault/parsing/session-record-time'
import { droidShellResult } from '../../acp/acp-dialects/droid-dialect'
import { claudeContentBlocks } from './transcript-record-blocks'

/** One Droid session record as chat history: the person's prompts, the model's replies and tool
 *  runs. Droid's hook runs and notices (`user_only`) and the context it injects (`llm_only`) stay
 *  out, as does reasoning, which the chat resumes inside Droid's own conversation. */
export function decodeDroidTranscriptLine(
  line: string
): { recordId: string; message: NativeChatMessage } | null {
  const record = parseJsonObject(line)
  const message = asRecord(record?.message)
  const id = extractString(record?.id)
  const role = message?.role
  if (
    record?.type !== 'message' ||
    !message ||
    !id ||
    message.visibility === 'user_only' ||
    message.visibility === 'llm_only' ||
    (role !== 'user' && role !== 'assistant')
  ) {
    return null
  }
  const content = Array.isArray(message.content)
    ? message.content.filter((part) => asRecord(part)?.type !== 'thinking')
    : message.content
  const blocks = claudeContentBlocks(content).map((block) => {
    const shell = block.type === 'tool-result' ? droidShellResult(block.output) : null
    return shell ? { ...block, output: shell.stdout } : block
  })
  if (blocks.length === 0) {
    return null
  }
  const parsedTime = timestampMs(record.timestamp)
  const model = role === 'assistant' ? extractString(message.modelId) : null
  return {
    recordId: id,
    message: {
      id,
      role:
        role === 'user' && blocks.every((block) => block.type === 'tool-result') ? 'tool' : role,
      blocks,
      timestamp: Number.isFinite(parsedTime) ? parsedTime : null,
      source: 'transcript',
      ...(model ? { model } : {})
    }
  }
}
