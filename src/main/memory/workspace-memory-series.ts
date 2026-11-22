import {
  chatInclusiveHistoryKey,
  deleteMemoryHistory,
  hasMemoryHistory,
  pushMemoryHistorySample,
  seedMemoryHistory,
  sweepStaleMemoryHistory,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'

type Usage = { cpu: number; memory: number; privateMemory: number }

/**
 * Records one sample of each workspace's history. The plain series is terminals only, taken while a
 * workspace has terminals, as it always was, so paired machines get the history they always had. A
 * workspace with chats also keeps a chat-inclusive series for this machine's row, continuing the plain
 * one and dropped when its chats end. Returns the workspaces with both, with their terminal-only usage.
 */
export function recordWorkspaceMemorySeries(
  buckets: readonly WorktreeMemoryBucket[],
  terminalUsage: ReadonlyMap<string, Usage>,
  now: number
): { worktreeId: string; usage: Usage }[] {
  const terminalSeries: { worktreeId: string; usage: Usage }[] = []
  for (const bucket of buckets) {
    const chatKey = chatInclusiveHistoryKey(bucket.worktreeId)
    if (!bucket.chats) {
      deleteMemoryHistory(chatKey)
    } else if (!hasMemoryHistory(chatKey)) {
      seedMemoryHistory(chatKey, bucket.worktreeId, now)
    }
    if (bucket.sessions.length > 0) {
      const usage = terminalUsage.get(bucket.worktreeId) ?? bucket
      pushMemoryHistorySample(bucket.worktreeId, usage.memory, now)
      if (bucket.chats) {
        terminalSeries.push({ worktreeId: bucket.worktreeId, usage })
      }
    }
    if (bucket.chats) {
      pushMemoryHistorySample(chatKey, bucket.memory, now)
    }
  }
  sweepStaleMemoryHistory(now)
  return terminalSeries
}
