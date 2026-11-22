import {
  chatInclusiveHistoryKey,
  deleteMemoryHistory,
  HISTORY_CAPACITY,
  pushMemoryHistorySample,
  readMemoryHistory,
  seedMemoryHistory,
  sweepStaleMemoryHistory,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'

type Usage = { cpu: number; memory: number; privateMemory: number }

// Workspaces with a chat-inclusive series, and the samples taken since their last chat.
const chatSeries = new Map<string, { samplesSinceChat: number; sweep: number }>()
let sweepCount = 0

/**
 * Records one sample of each workspace's history. The plain series is terminals only, taken while a
 * workspace has terminals, as it always was, so paired machines get the history they always had. From
 * a workspace's first chat, this machine's row reads a chat-inclusive series that continues the plain
 * one; after its chats end it keeps sampling until no chat sample is left in it, then gives way to the
 * plain series, which by then holds the same samples. Returns the workspaces with terminals and chats,
 * with their terminal-only usage.
 */
export function recordWorkspaceMemorySeries(
  buckets: readonly WorktreeMemoryBucket[],
  terminalUsage: ReadonlyMap<string, Usage>,
  now: number
): { worktreeId: string; usage: Usage }[] {
  const terminalSeries: { worktreeId: string; usage: Usage }[] = []
  const sweep = ++sweepCount
  for (const bucket of buckets) {
    // A sample without chats skips the lookup.
    const entry =
      bucket.chats || chatSeries.size > 0 ? chatSeries.get(bucket.worktreeId) : undefined
    const chatKey = bucket.chats || entry ? chatInclusiveHistoryKey(bucket.worktreeId) : null
    if (bucket.chats && !entry) {
      seedMemoryHistory(chatInclusiveHistoryKey(bucket.worktreeId), bucket.worktreeId, now)
      chatSeries.set(bucket.worktreeId, { samplesSinceChat: 0, sweep })
    } else if (entry) {
      entry.samplesSinceChat = bucket.chats ? 0 : entry.samplesSinceChat + 1
      entry.sweep = sweep
    }
    if (bucket.sessions.length > 0) {
      const usage = terminalUsage.get(bucket.worktreeId) ?? bucket
      pushMemoryHistorySample(bucket.worktreeId, usage.memory, now)
      if (bucket.chats) {
        terminalSeries.push({ worktreeId: bucket.worktreeId, usage })
      }
    }
    if (chatKey) {
      if (entry && entry.samplesSinceChat >= HISTORY_CAPACITY) {
        deleteMemoryHistory(chatKey)
        chatSeries.delete(bucket.worktreeId)
      } else {
        pushMemoryHistorySample(chatKey, bucket.memory, now)
      }
    }
  }
  // A workspace that left the sample has no row to draw its chat-inclusive series.
  for (const [worktreeId, entry] of chatSeries) {
    if (entry.sweep !== sweep) {
      deleteMemoryHistory(chatInclusiveHistoryKey(worktreeId))
      chatSeries.delete(worktreeId)
    }
  }
  sweepStaleMemoryHistory(now)
  return terminalSeries
}

/** The history this machine's row for the workspace draws. */
export function readWorkspaceHistory(worktreeId: string): number[] {
  return readMemoryHistory(
    chatSeries.size > 0 && chatSeries.has(worktreeId)
      ? chatInclusiveHistoryKey(worktreeId)
      : worktreeId
  )
}
