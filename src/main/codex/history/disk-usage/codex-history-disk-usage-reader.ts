import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'

export type CodexHistoryDiskUsageReader = {
  /**
   * `measure` runs only when no reusable or running walk exists; its signal stops the walk. A read
   * with a `consumer` joins the walk under that name; one without keeps the walk to its end.
   */
  read: (
    measure: (signal: AbortSignal) => Promise<CodexHistoryDiskUsage>,
    consumer?: string
  ) => Promise<CodexHistoryDiskUsage>
  /** That consumer stopped waiting; the running walk stops once no reader is left. */
  release: (consumer: string) => void
  /** History shrank: the running walk is stopped and no later read returns one from before now. */
  forget: () => void
}

type InFlight = {
  walk: Promise<CodexHistoryDiskUsage>
  abort: AbortController
  consumers: Set<string>
  /** A read that named no consumer, so nothing can release it. */
  held: boolean
}

/** One walk at a time, reused for `reuseMs`, stopped by a deletion or when its last reader leaves. */
export function createCodexHistoryDiskUsageReader(
  reuseMs: number,
  now: () => number = Date.now
): CodexHistoryDiskUsageReader {
  let last: { usage: CodexHistoryDiskUsage; at: number } | null = null
  let inFlight: InFlight | null = null
  const stop = (): void => {
    inFlight?.abort.abort()
    inFlight = null
  }
  const join = (running: InFlight, consumer: string | undefined): void => {
    if (consumer) {
      running.consumers.add(consumer)
    } else {
      running.held = true
    }
  }
  return {
    read: (measure, consumer) => {
      if (last && now() - last.at < reuseMs) {
        return Promise.resolve(last.usage)
      }
      if (inFlight) {
        join(inFlight, consumer)
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
      inFlight = { walk, abort, consumers: new Set(), held: false }
      join(inFlight, consumer)
      return walk
    },
    release: (consumer) => {
      if (inFlight?.consumers.delete(consumer) && inFlight.consumers.size === 0 && !inFlight.held) {
        stop()
      }
    },
    forget: () => {
      last = null
      // Its count predates the deletion; stopping it keeps a burst of deletions to one walk.
      stop()
    }
  }
}
