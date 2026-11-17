import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

export type CodexHistoryDiskUsageReader = {
  /** `measure` runs only when no reusable or current walk exists. */
  read: (measure: () => Promise<CodexHistoryDiskUsage>) => Promise<CodexHistoryDiskUsage>
  /** History shrank: no later read returns a walk that started before now. */
  forget: () => void
}

/** One walk at a time, reused for `reuseMs`; a deletion retires both the reused and the running walk. */
export function createCodexHistoryDiskUsageReader(
  reuseMs: number,
  now: () => number = Date.now
): CodexHistoryDiskUsageReader {
  let generation = 0
  let last: { usage: CodexHistoryDiskUsage; at: number } | null = null
  let inFlight: { generation: number; walk: Promise<CodexHistoryDiskUsage> } | null = null
  return {
    read: (measure) => {
      if (last && now() - last.at < reuseMs) {
        return Promise.resolve(last.usage)
      }
      if (inFlight?.generation === generation) {
        return inFlight.walk
      }
      const startedIn = generation
      const walk = measure()
        .then((usage) => {
          if (startedIn === generation) {
            last = { usage, at: now() }
          }
          return usage
        })
        .finally(() => {
          if (inFlight?.walk === walk) {
            inFlight = null
          }
        })
      inFlight = { generation: startedIn, walk }
      return walk
    },
    forget: () => {
      generation += 1
      last = null
    }
  }
}
