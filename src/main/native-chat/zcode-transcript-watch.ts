import { readZcodeSqliteTranscriptViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { resolveZcodeSqliteDbPath } from '../ai-vault/zcode-sqlite-transcript'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

const ZCODE_TRANSCRIPT_POLL_MS = 750
const ZCODE_APPEND_PAGE_LIMIT = 500
const ZCODE_MAX_PAGES_PER_POLL = 4

export function subscribeZcodeSqliteTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): NativeChatTranscriptSubscription {
  const dbPath = resolveZcodeSqliteDbPath(args.transcriptPath ?? args.filePath)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let offset: number | undefined
  let initialized = false
  let initialErrorEmitted = false

  const schedule = (): void => {
    if (closed) {
      return
    }
    timer = setTimeout(() => void poll(), args.reconciliationIntervalMs ?? ZCODE_TRANSCRIPT_POLL_MS)
    timer.unref?.()
  }

  const poll = async (): Promise<void> => {
    if (closed || setupSignal?.aborted) {
      return
    }
    try {
      if (!initialized) {
        const initial = await readZcodeSqliteTranscriptViaWorker({
          dbPath,
          sessionId: args.sessionId,
          limit: args.initialLimit ?? 40
        })
        if (closed || setupSignal?.aborted) {
          return
        }
        offset = initial.nextOffset
        initialized = true
        args.onInitialSnapshot?.(initial.messages, initial.limited, initial.beforeOffset)
      } else {
        for (let pageIndex = 0; pageIndex < ZCODE_MAX_PAGES_PER_POLL; pageIndex += 1) {
          const page = await readZcodeSqliteTranscriptViaWorker({
            dbPath,
            sessionId: args.sessionId,
            offset,
            limit: ZCODE_APPEND_PAGE_LIMIT
          })
          if (closed || setupSignal?.aborted) {
            return
          }
          offset = page.nextOffset
          if (page.messages.length > 0) {
            args.onAppend(page.messages)
          }
          if (!page.limited) {
            break
          }
        }
      }
    } catch (error) {
      if (!initialized && !initialErrorEmitted && args.onInitialSnapshot) {
        initialErrorEmitted = true
        args.onInitialSnapshot(
          [],
          false,
          0,
          error instanceof Error ? error.message : 'Transcript unavailable'
        )
      }
    }
    schedule()
  }

  void poll()
  return {
    watching: true,
    unsubscribe: () => {
      closed = true
      if (timer) {
        clearTimeout(timer)
      }
      timer = null
    }
  }
}
