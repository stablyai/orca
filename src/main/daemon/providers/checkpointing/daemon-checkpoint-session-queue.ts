// Serialize per session so a stalled checkpoint cannot block other terminals; deadlines abandon waits, not writes.

export const CHECKPOINT_SESSION_QUEUE_MAX_PENDING = 3

type DeadlineCallbacks = {
  onDeadline?: () => void
  onAbandonedRejection?: (error: unknown) => void
}

export class CheckpointSessionQueue {
  private tails = new Map<string, Promise<unknown>>()
  private pending = new Map<string, number>()

  isSaturated(sessionId: string): boolean {
    return (this.pending.get(sessionId) ?? 0) >= CHECKPOINT_SESSION_QUEUE_MAX_PENDING
  }

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(sessionId, operation)
  }

  /** Resolve onDeadline after the wait budget; the queued operation still runs to completion. */
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

  // Never clear active tails: overlapping writes to a session's temp file can lose a checkpoint.

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
    // Observe the shared tail's rejection as well as the caller's promise.
    next.then(settle, settle)
    return next
  }
}
