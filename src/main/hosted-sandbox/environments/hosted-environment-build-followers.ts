// Pull-based build following for the CLI: the runtime RPC is request/response, so main keeps one
// watch per build, buffers its log (bounded), and answers cursor polls. Reconnect replays are
// deduplicated here, so a CLI tailing the log never prints a line twice.
import type { HostedEnvironmentBuildView } from '../../../shared/hosted-sandbox/hosted-environment-wire'
import { watchHostedEnvironmentBuild } from './hosted-environment-build-watch'
import type { HostedEnvironmentClient } from './hosted-environment-client'

export type HostedEnvironmentBuildLogChunk = { stream: 'stdout' | 'stderr'; data: string }

export type HostedEnvironmentBuildFollowPoll = {
  build: HostedEnvironmentBuildView | null
  chunks: HostedEnvironmentBuildLogChunk[]
  /** Pass back on the next poll. */
  cursor: number
  /** Output was lost between polls: the cursor fell behind the buffer (older log dropped), or the
   *  follower was recreated and the log restarts from its first byte (some lines may repeat). */
  truncated: boolean
  /** Final status reached and the whole log delivered (or the watch failed: see `error`). */
  done: boolean
  error: string | null
}

type Follower = {
  chunks: { seq: number; chunk: HostedEnvironmentBuildLogChunk }[]
  bufferedChars: number
  nextSeq: number
  build: HostedEnvironmentBuildView | null
  done: boolean
  error: string | null
  lastPollAt: number
  stop: () => void
  waiters: Set<() => void>
}

export type HostedEnvironmentBuildFollowers = {
  poll(
    client: Pick<HostedEnvironmentClient, 'openBuildEvents' | 'getBuild'>,
    envId: string,
    buildId: string,
    cursor: number,
    waitMs: number
  ): Promise<HostedEnvironmentBuildFollowPoll>
  dispose(): void
}

const MAX_BUFFERED_CHARS = 4 * 1024 * 1024
// Across every follower: 16 followers at their own cap would otherwise hold 64 MB.
const MAX_TOTAL_BUFFERED_CHARS = 16 * 1024 * 1024
const MAX_CHUNKS_PER_POLL = 2_000
const MAX_FOLLOWERS = 16
// A CLI that stopped polling (Ctrl-C) lets its follower go after this.
const ABANDONED_AFTER_MS = 60_000

export function createHostedEnvironmentBuildFollowers(
  options: {
    now?: () => number
    idleTimeoutMs?: number
    backoffMs?: readonly number[]
    maxTotalBufferedChars?: number
  } = {}
): HostedEnvironmentBuildFollowers {
  const now = options.now ?? Date.now
  const maxTotal = options.maxTotalBufferedChars ?? MAX_TOTAL_BUFFERED_CHARS
  const followers = new Map<string, Follower>()
  let totalChars = 0

  const dropOldest = (follower: Follower): boolean => {
    // The newest chunk stays so a poller always has something to resume from.
    if (follower.chunks.length <= 1) {
      return false
    }
    const dropped = follower.chunks.shift()
    const size = dropped?.chunk.data.length ?? 0
    follower.bufferedChars -= size
    totalChars -= size
    return true
  }

  const enforceTotalCap = (): void => {
    while (totalChars > maxTotal) {
      let largest: Follower | null = null
      for (const candidate of followers.values()) {
        if (
          candidate.chunks.length > 1 &&
          (!largest || candidate.bufferedChars > largest.bufferedChars)
        ) {
          largest = candidate
        }
      }
      if (!largest || !dropOldest(largest)) {
        return
      }
    }
  }

  const remove = (key: string): void => {
    const follower = followers.get(key)
    if (follower) {
      followers.delete(key)
      totalChars -= follower.bufferedChars
      follower.stop()
      for (const wake of follower.waiters) {
        wake()
      }
    }
  }

  const sweep = (): void => {
    for (const [key, follower] of followers) {
      if (now() - follower.lastPollAt > ABANDONED_AFTER_MS) {
        remove(key)
      }
    }
  }

  const makeRoom = (): void => {
    while (followers.size >= MAX_FOLLOWERS) {
      const oldest = followers.keys().next().value
      if (oldest === undefined) {
        break
      }
      remove(oldest)
    }
  }

  // Followers whose CLI went away keep streaming until swept, so sweep on a slow beat too.
  // Runs only while followers exist and stops once the last one is swept.
  let sweeper: ReturnType<typeof setTimeout> | null = null
  const ensureSweeper = (): void => {
    if (sweeper) {
      return
    }
    sweeper = setTimeout(() => {
      sweeper = null
      sweep()
      if (followers.size > 0) {
        ensureSweeper()
      }
    }, ABANDONED_AFTER_MS / 2)
    sweeper.unref?.()
  }

  const start = (
    client: Pick<HostedEnvironmentClient, 'openBuildEvents' | 'getBuild'>,
    envId: string,
    buildId: string
  ): Follower => {
    const follower: Follower = {
      chunks: [],
      bufferedChars: 0,
      nextSeq: 0,
      build: null,
      done: false,
      error: null,
      lastPollAt: now(),
      stop: () => undefined,
      waiters: new Set()
    }
    // Chars of the log already buffered across passes, and how far the current replay has reached.
    let deliveredChars = 0
    let replayChars = 0
    const wake = (): void => {
      for (const resolve of follower.waiters) {
        resolve()
      }
      follower.waiters.clear()
    }
    const push = (chunk: HostedEnvironmentBuildLogChunk): void => {
      follower.chunks.push({ seq: follower.nextSeq++, chunk })
      follower.bufferedChars += chunk.data.length
      totalChars += chunk.data.length
      while (follower.bufferedChars > MAX_BUFFERED_CHARS && dropOldest(follower)) {
        // Trimmed one chunk.
      }
      enforceTotalCap()
    }
    const watch = watchHostedEnvironmentBuild({
      client,
      envId,
      buildId,
      ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      onEvent: (event) => {
        switch (event.type) {
          case 'build':
            follower.build = event.build
            break
          case 'reset':
            replayChars = 0
            break
          case 'reconnecting':
            break
          case 'log': {
            // Skip the part of the replay already delivered, then pass the rest through.
            const start = replayChars
            replayChars += event.data.length
            if (replayChars <= deliveredChars) {
              return
            }
            const fresh =
              start >= deliveredChars ? event.data : event.data.slice(deliveredChars - start)
            deliveredChars = replayChars
            push({ stream: event.stream, data: fresh })
            break
          }
          case 'end':
            follower.done = true
            break
          case 'error':
            follower.done = true
            follower.error = event.message
            break
        }
        wake()
      }
    })
    follower.stop = watch.stop
    return follower
  }

  return {
    async poll(client, envId, buildId, requestedCursor, waitMs) {
      const key = `${envId}/${buildId}`
      sweep()
      ensureSweeper()
      let follower = followers.get(key)
      if (!follower) {
        makeRoom()
        follower = start(client, envId, buildId)
        followers.set(key, follower)
      }
      follower.lastPollAt = now()
      // A cursor from a previous follower (swept or evicted, then recreated) points past this one's
      // log: restart from its first byte and say output may repeat.
      const restarted = requestedCursor > follower.nextSeq
      const cursor = restarted ? 0 : requestedCursor
      const hasNews = (): boolean => follower.done || (follower.chunks.at(-1)?.seq ?? -1) >= cursor
      if (!hasNews() && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, waitMs)
          timer.unref?.()
          function done(): void {
            clearTimeout(timer)
            follower!.waiters.delete(done)
            resolve()
          }
          follower!.waiters.add(done)
        })
      }
      const first = follower.chunks[0]?.seq ?? follower.nextSeq
      const truncated = restarted || cursor < first
      const pending = follower.chunks.filter((entry) => entry.seq >= cursor)
      const page = pending.slice(0, MAX_CHUNKS_PER_POLL)
      const last = page.at(-1)
      const nextCursor = last ? last.seq + 1 : Math.max(cursor, first)
      const drained = page.length === pending.length
      const result: HostedEnvironmentBuildFollowPoll = {
        build: follower.build,
        chunks: page.map((entry) => entry.chunk),
        cursor: nextCursor,
        truncated,
        done: follower.done && drained,
        error: follower.done && drained ? follower.error : null
      }
      if (result.done) {
        // Keep it briefly so a retried final poll still answers; the sweep drops it later.
        follower.lastPollAt = now() - ABANDONED_AFTER_MS + 5_000
      }
      return result
    },
    dispose() {
      if (sweeper) {
        clearTimeout(sweeper)
        sweeper = null
      }
      // Deleting the current key while iterating a Map is safe.
      for (const key of followers.keys()) {
        remove(key)
      }
    }
  }
}
