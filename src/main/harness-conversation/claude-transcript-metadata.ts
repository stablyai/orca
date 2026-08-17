import { readNativeChatTranscriptTailFile } from '../native-chat/transcript-tail-reader'
import { claudeTextMessage } from './claude-message'

export type ClaudeTranscriptMetadata = { model?: string; effort?: string }

export async function readClaudeTranscriptMetadata(
  path: string
): Promise<ClaudeTranscriptMetadata | null> {
  let metadata: ClaudeTranscriptMetadata | null = null
  await readNativeChatTranscriptTailFile(
    path,
    0,
    (line, fallbackId) => {
      if (metadata) {
        return null
      }
      const record = JSON.parse(line) as {
        type?: unknown
        effort?: unknown
        message?: { model?: unknown }
      }
      if (record.type !== 'assistant') {
        return null
      }
      const model = typeof record.message?.model === 'string' ? record.message.model : undefined
      const effort = typeof record.effort === 'string' ? record.effort : undefined
      if (!model && !effort) {
        return null
      }
      metadata = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      return claudeTextMessage(fallbackId, 'assistant', '')
    },
    true
  )
  return metadata
}
