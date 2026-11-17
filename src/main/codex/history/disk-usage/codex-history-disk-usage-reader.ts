import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

export type CodexHistoryDiskUsageReader = {
  /** `measure` runs only when no reusable or current walk exists; its signal aborts an obsolete walk. */
  read: (measure: (signal: AbortSignal) => Promise<CodexHistoryDiskUsage>) => Promise<CodexHistoryDiskUsage>
  /** History shrank: the running walk is stopped and no later read returns one from before now. */
  forget: () => void
}

/** One walk at a time, reused for `reuseMs`; a deletion retires both the reused and the running walk. */
export function createCodexHistoryDiskUsageReader(
  reuseMs: number,
  now: () => number = Date.now
): CodexHistoryDiskUsageReader {
  let last: { usage: CodexHistoryDiskUsage; at: number } | null = null
  let inFlight: { walk: Promise<CodexHistoryDiskUsage>; abort: AbortController } | null = null
  return {
    read: (measure) => {
      if (last && now() - last.at < reuseMs) {
        return Promise.resolve(last.usage)
      }
      if (inFlight) {
        return inFlight.walk
      }
      const abort = new AbortController()
      const walk = measure(abort.signal)
        .then((usage) => {
          if (!abort.signal.aborted) {
            last = { usage, at: now() }
          }
          return usage
        })
        .finally(() => {
          if (inFlight?.walk === walk) {
            inFlight = null
          }
        })
      inFlight = { walk, abort }
      return walk
    },
    forget: () => {
      last = null
      // Its count predates the deletion; stopping it keeps a burst of deletions to one walk.
      inFlight?.abort.abort()
      inFlight = null
    }
  }
}
