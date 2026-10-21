export type MultiplexPtyWaitAdmission = {
  /** False when both the running slots and the queue are full. */
  hasRoom: () => boolean
  /** Resolves true once a running slot is held, or false if `signal` aborts first. */
  acquire: (signal: AbortSignal) => Promise<boolean>
  release: () => void
}

// Why FIFO: a restore subscribes panes in layout order, and queued waits must not start their PTY timeout until admitted.
export function createMultiplexPtyWaitAdmission(
  maxRunning: number,
  maxQueued: number
): MultiplexPtyWaitAdmission {
  let running = 0
  const queue: { admit: () => void }[] = []

  const admitNext = (): void => {
    while (running < maxRunning && queue.length > 0) {
      running += 1
      queue.shift()?.admit()
    }
  }

  return {
    hasRoom: () => running < maxRunning || queue.length < maxQueued,
    acquire: (signal) => {
      if (signal.aborted) {
        return Promise.resolve(false)
      }
      if (running < maxRunning && queue.length === 0) {
        running += 1
        return Promise.resolve(true)
      }
      return new Promise<boolean>((resolve) => {
        const entry = {
          admit: (): void => {
            signal.removeEventListener('abort', onAbort)
            resolve(true)
          }
        }
        const onAbort = (): void => {
          const index = queue.indexOf(entry)
          if (index !== -1) {
            queue.splice(index, 1)
          }
          resolve(false)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        queue.push(entry)
      })
    },
    release: () => {
      running = Math.max(0, running - 1)
      admitNext()
    }
  }
}
