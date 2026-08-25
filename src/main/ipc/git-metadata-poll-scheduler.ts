import { performance } from 'node:perf_hooks'

export const GIT_METADATA_FILESYSTEM_CONCURRENCY = 8

export type GitMetadataWindowVisibility = {
  isWindowVisible: () => boolean
  onWindowBecameVisible: (listener: () => void) => () => void
}

export type GitMetadataPollContext = {
  isVisibilityCatchUp: boolean
}

export type GitMetadataPollSchedule = {
  setIntervalMs: (intervalMs: number) => void
  reschedule: (delayMs?: number) => void
  unsubscribe: () => void
}

type ScheduledPoll = {
  id: number
  intervalMs: number
  dueAt: number
  visibility: GitMetadataWindowVisibility
  run: (context: GitMetadataPollContext) => void | Promise<void>
  unsubscribeVisibility: () => void
  queued: boolean
  running: boolean
  rerunPending: boolean
  pendingVisibilityCatchUp: boolean
  parkedWhileHidden: boolean
  disposed: boolean
}

type FilesystemOperation = {
  execute: () => Promise<void>
}

function normalizeDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function staggerOffset(key: string, intervalMs: number): number {
  if (intervalMs <= 1) {
    return intervalMs
  }
  // FNV-1a gives stable host-local phases without retaining a separate slot table.
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return 1 + ((hash >>> 0) % intervalMs)
}

/**
 * One main-process scheduler for recurring Git metadata probes. It owns a single
 * timer, gives each target a stable phase inside its detection interval, coalesces
 * overdue work to one rerun per target, and limits both checks and their filesystem
 * operations. A relay process gets its own singleton, so the ceiling is host-local.
 */
export class GitMetadataPollScheduler {
  private readonly polls = new Map<number, ScheduledPoll>()
  private readonly pollQueue: ScheduledPoll[] = []
  private readonly filesystemQueue: FilesystemOperation[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private activePolls = 0
  private activeFilesystemOperations = 0

  constructor(
    private readonly concurrency = GIT_METADATA_FILESYSTEM_CONCURRENCY,
    private readonly now: () => number = () => performance.now()
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Git metadata scheduler concurrency must be a positive integer')
    }
  }

  schedule(options: {
    key: string
    intervalMs: number
    visibility: GitMetadataWindowVisibility
    run: (context: GitMetadataPollContext) => void | Promise<void>
  }): GitMetadataPollSchedule {
    const intervalMs = normalizeDelay(options.intervalMs)
    const poll: ScheduledPoll = {
      id: this.nextId++,
      intervalMs,
      dueAt: Number.POSITIVE_INFINITY,
      visibility: options.visibility,
      run: options.run,
      unsubscribeVisibility: () => {},
      queued: false,
      running: false,
      rerunPending: false,
      pendingVisibilityCatchUp: false,
      parkedWhileHidden: false,
      disposed: false
    }
    const now = this.now()
    if (poll.visibility.isWindowVisible()) {
      poll.dueAt = now + staggerOffset(options.key, intervalMs)
    } else {
      poll.parkedWhileHidden = true
    }
    const visibilityCatchUp = (): void => {
      if (poll.disposed || !poll.parkedWhileHidden || !poll.visibility.isWindowVisible()) {
        return
      }
      poll.parkedWhileHidden = false
      poll.dueAt = this.now() + poll.intervalMs
      this.enqueuePoll(poll, true)
      this.armTimer()
    }
    poll.unsubscribeVisibility = poll.visibility.onWindowBecameVisible(visibilityCatchUp)
    this.polls.set(poll.id, poll)
    this.armTimer()

    return {
      setIntervalMs: (nextIntervalMs) => {
        if (poll.disposed) {
          return
        }
        poll.intervalMs = normalizeDelay(nextIntervalMs)
        if (poll.running && poll.visibility.isWindowVisible()) {
          poll.dueAt = this.now() + poll.intervalMs
          this.armTimer()
        }
      },
      reschedule: (delayMs = poll.intervalMs) => {
        if (poll.disposed) {
          return
        }
        if (poll.visibility.isWindowVisible()) {
          poll.parkedWhileHidden = false
          poll.dueAt = this.now() + normalizeDelay(delayMs)
        } else {
          poll.parkedWhileHidden = true
          poll.dueAt = Number.POSITIVE_INFINITY
        }
        this.armTimer()
      },
      unsubscribe: () => this.unsubscribePoll(poll)
    }
  }

  runFilesystemIo<T>(run: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    this.filesystemQueue.push({
      execute: async () => {
        try {
          resolve(await run())
        } catch (error) {
          reject(error)
        }
      }
    })
    this.drainFilesystemQueue()
    return promise
  }

  private unsubscribePoll(poll: ScheduledPoll): void {
    if (poll.disposed) {
      return
    }
    poll.disposed = true
    poll.unsubscribeVisibility()
    this.polls.delete(poll.id)
    if (poll.queued) {
      const index = this.pollQueue.indexOf(poll)
      if (index !== -1) {
        this.pollQueue.splice(index, 1)
      }
      poll.queued = false
    }
    this.armTimer()
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    let nextDueAt = Number.POSITIVE_INFINITY
    for (const poll of this.polls.values()) {
      if (!poll.disposed && poll.dueAt < nextDueAt) {
        nextDueAt = poll.dueAt
      }
    }
    if (!Number.isFinite(nextDueAt)) {
      return
    }
    this.timer = setTimeout(() => this.collectDuePolls(), Math.max(0, nextDueAt - this.now()))
    this.timer.unref?.()
  }

  private collectDuePolls(): void {
    this.timer = null
    const now = this.now()
    for (const poll of this.polls.values()) {
      if (poll.disposed || poll.dueAt > now) {
        continue
      }
      if (!poll.visibility.isWindowVisible()) {
        poll.parkedWhileHidden = true
        poll.dueAt = Number.POSITIVE_INFINITY
        continue
      }
      poll.dueAt = this.nextDueAt(poll.dueAt, poll.intervalMs, now)
      this.enqueuePoll(poll, false)
    }
    this.armTimer()
  }

  private nextDueAt(previousDueAt: number, intervalMs: number, now: number): number {
    if (intervalMs === 0) {
      return now
    }
    const elapsedIntervals = Math.floor(Math.max(0, now - previousDueAt) / intervalMs) + 1
    return previousDueAt + elapsedIntervals * intervalMs
  }

  private enqueuePoll(poll: ScheduledPoll, isVisibilityCatchUp: boolean): void {
    if (poll.disposed) {
      return
    }
    if (poll.running || poll.queued) {
      poll.rerunPending = true
      poll.pendingVisibilityCatchUp ||= isVisibilityCatchUp
      return
    }
    poll.queued = true
    poll.pendingVisibilityCatchUp = isVisibilityCatchUp
    this.pollQueue.push(poll)
    this.drainPollQueue()
  }

  private drainPollQueue(): void {
    while (this.activePolls < this.concurrency && this.pollQueue.length > 0) {
      const poll = this.pollQueue.shift()!
      poll.queued = false
      if (poll.disposed) {
        continue
      }
      if (!poll.visibility.isWindowVisible()) {
        poll.parkedWhileHidden = true
        poll.dueAt = Number.POSITIVE_INFINITY
        poll.rerunPending = false
        poll.pendingVisibilityCatchUp = false
        continue
      }
      const isVisibilityCatchUp = poll.pendingVisibilityCatchUp
      poll.pendingVisibilityCatchUp = false
      poll.running = true
      this.activePolls++
      let result: void | Promise<void>
      try {
        result = poll.run({ isVisibilityCatchUp })
      } catch {
        result = undefined
      }
      void Promise.resolve(result)
        .catch(() => {
          // Each poller owns its transient-error policy; keep the host scheduler alive.
        })
        .finally(() => {
          poll.running = false
          this.activePolls--
          if (!poll.disposed && poll.rerunPending) {
            const catchUp = poll.pendingVisibilityCatchUp
            poll.rerunPending = false
            poll.pendingVisibilityCatchUp = false
            this.enqueuePoll(poll, catchUp)
          }
          this.drainPollQueue()
        })
    }
  }

  private drainFilesystemQueue(): void {
    while (this.activeFilesystemOperations < this.concurrency && this.filesystemQueue.length > 0) {
      const operation = this.filesystemQueue.shift()!
      this.activeFilesystemOperations++
      void operation.execute().finally(() => {
        this.activeFilesystemOperations--
        this.drainFilesystemQueue()
      })
    }
  }
}

export const gitMetadataPollScheduler = new GitMetadataPollScheduler()

export function runGitMetadataFilesystemIo<T>(run: () => Promise<T>): Promise<T> {
  return gitMetadataPollScheduler.runFilesystemIo(run)
}
