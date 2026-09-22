import type { NativeChatMessage } from '../../shared/native-chat-types'
import { readZcodeSqliteTranscriptViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { resolveZcodeSqliteDbPath } from '../ai-vault/zcode-sqlite-transcript'

export async function readZcodeTranscriptTail(
  args: {
    sessionId: string
    transcriptPath?: string
    filePath?: string
    beforeOffset?: number
    limit: number
  },
  signal?: AbortSignal
): Promise<
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }
> {
  try {
    const result = await readZcodeSqliteTranscriptViaWorker({
      dbPath: resolveZcodeSqliteDbPath(args.transcriptPath ?? args.filePath),
      sessionId: args.sessionId,
      beforeOffset: args.beforeOffset,
      limit: args.limit
    })
    signal?.throwIfAborted()
    return {
      messages: result.messages,
      hasMore: result.limited,
      beforeOffset: result.beforeOffset
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT' || message.includes('does not exist')
      ? { error: message, notFound: true }
      : { error: message }
  }
}
