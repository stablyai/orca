/**
 * Serializes terminal-history checkpoint work per session.
 *
 * Why per session and not one process-wide tail: checkpoint exclusivity only
 * protects one session directory's tmp-write/rename pair. A single global tail
 * made a warm reattach wait on every other session's checkpoint, so one
 * never-settling checkpoint blocked every daemon-backed terminal (STA-4173).
 *
 * Why deadlines never cancel: an operation that blows its deadline keeps running
 * to completion. Waiters degrade (older snapshot, retry next tick) instead of
 * dropping durable history that a later reattach would need.
 */

/** Running plus queued operations one session may hold before callers are turned away. */
export const CHECKPOINT_SESSION_QUEUE_MAX_PENDING = 3

type DeadlineCallbacks = {
  onDeadline?: () => void
  onAbandonedRejection?: (error: unknown) => void
}

export class CheckpointSessionQueue {
  private tails = new Map<string, Promise<unknown>>()
  private pending = new Map<string, number>()

  /** True when the session's queue is full and a new caller should degrade instead of wait. */
  isSaturated(sessionId: string): boolean {
    return (this.pending.get(sessionId) ?? 0) >= CHECKPOINT_SESSION_QUEUE_MAX_PENDING
  }

  /** Waits for the session's turn and resolves when the operation finishes. */
  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(sessionId, operation)
  }

  /**
   * Waits for the session's turn, giving up after `deadlineMs` and resolving
   * `onDeadline`. The operation still runs to completion in the background.
   */
  runWithDeadline<T>(
    sessionId: string,
    operation: () => Promise<T>,
    deadlineMs: number,
    onDeadline: T,
    callbacks: DeadlineCallbacks = {}
  ): Promise<T> {
    const work = this.enqueue(sessionId, operation)
    return new Promise<T>((resolve, reject) => {
      let deadlineFired = false
      const timer = setTimeout(() => {
        deadlineFired = true
        try {
          callbacks.onDeadline?.()
        } finally {
          resolve(onDeadline)
        }
      }, deadlineMs)
      timer.unref?.()
      work.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (deadlineFired) {
            callbacks.onAbandonedRejection?.(error)
            return
          }
          reject(error)
        }
      )
    })
  }

  // Why there is no clear(): dropping a tail while its write is parked would let the next caller
  // into the same session directory, and two concurrent tmp-write/rename pairs lose a checkpoint.
  // Entries remove themselves as operations settle, so a stalled session pins one entry at most.

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1)
    const next = previous.catch(() => {}).then(operation)
    this.tails.set(sessionId, next)
    const settle = (): void => {
      const remaining = (this.pending.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        this.pending.set(sessionId, remaining)
        return
      }
      this.pending.delete(sessionId)
      if (this.tails.get(sessionId) === next) {
        this.tails.delete(sessionId)
      }
    }
    // Why a detached handler: `next` is the shared tail, so a rejection the caller
    // already sees would still surface here as an unhandled rejection.
    next.then(settle, settle)
    return next
  }
}
