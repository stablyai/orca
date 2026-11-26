/** Holds the stream reader while the consumer applies backpressure. */
export type ClaudeReadingBarrier = {
  isPaused: () => boolean
  pauseReading: () => void
  resumeReading: () => void
  waitUntilReadable: () => Promise<void>
}

export function createClaudeReadingBarrier(isDone: () => boolean): ClaudeReadingBarrier {
  let barrier: Promise<void> | null = null
  let release: (() => void) | null = null
  return {
    isPaused: () => barrier !== null,
    pauseReading: () => {
      if (isDone() || barrier) {
        return
      }
      barrier = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    resumeReading: () => {
      const resolve = release
      barrier = null
      release = null
      resolve?.()
    },
    waitUntilReadable: () => barrier ?? Promise.resolve()
  }
}
