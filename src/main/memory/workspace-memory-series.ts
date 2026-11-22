import {
  hasMemoryHistory,
  pushMemoryHistorySample,
  retireConvergedMemoryHistory,
  seedMemoryHistory,
  sweepStaleMemoryHistory,
  terminalOnlyHistoryKey,
  touchMemoryHistory,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'

type Usage = { cpu: number; memory: number; privateMemory: number }

/**
 * Records one sample of each workspace's history. The plain series is what this machine shows (chats
 * included). From a workspace's first chat it also keeps a terminal-only series for paired machines:
 * a copy of the plain one, which held terminals alone until then. Returns those workspaces' terminal usage.
 */
export function recordWorkspaceMemorySeries(
  buckets: readonly WorktreeMemoryBucket[],
  terminalUsage: ReadonlyMap<string, Usage>,
  now: number
): { worktreeId: string; usage: Usage }[] {
  const terminalSeries: { worktreeId: string; usage: Usage }[] = []
  for (const bucket of buckets) {
    const terminalKey = terminalOnlyHistoryKey(bucket.worktreeId)
    let separate = hasMemoryHistory(terminalKey)
    if (bucket.chats && !separate) {
      // Until its first chat, the plain series held terminals alone, so it seeds the terminal-only one.
      seedMemoryHistory(terminalKey, bucket.worktreeId, now)
      separate = true
    }
    if (separate) {
      if (bucket.sessions.length > 0) {
        const usage = terminalUsage.get(bucket.worktreeId) ?? bucket
        pushMemoryHistorySample(terminalKey, usage.memory, now)
        // With no chats both series take the same sample, so after a full series they are equal.
        if (!retireConvergedMemoryHistory(terminalKey, !bucket.chats)) {
          terminalSeries.push({ worktreeId: bucket.worktreeId, usage })
        }
      } else {
        touchMemoryHistory(terminalKey, now)
        retireConvergedMemoryHistory(terminalKey, false)
      }
    }
    pushMemoryHistorySample(bucket.worktreeId, bucket.memory, now)
  }
  sweepStaleMemoryHistory(now)
  return terminalSeries
}
