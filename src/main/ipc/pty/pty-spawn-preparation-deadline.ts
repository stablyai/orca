/** Maximum time spent preparing a spawn before a provider process is issued. */
export const PTY_SPAWN_PREPARATION_DEADLINE_MS = 60_000

export function createPtySpawnPreparationDeadline(options: { onTimeout: () => void }): {
  start: () => void
  assertPreparing: () => void
  finish: () => void
  race: <T>(operation: Promise<T>) => Promise<T>
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let finished = false
  let expired = false
  let rejectExpired!: (error: Error) => void
  const expiredPromise = new Promise<never>((_, reject) => {
    rejectExpired = reject
  })
  // The race may have completed before the timer callback runs.
  void expiredPromise.catch(() => {})
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return {
    start: () => {
      if (started || finished) {
        return
      }
      started = true
      timer = setTimeout(() => {
        expired = true
        const error = new Error('PTY spawn preparation timed out before provider spawn')
        options.onTimeout()
        rejectExpired(error)
      }, PTY_SPAWN_PREPARATION_DEADLINE_MS)
    },
    assertPreparing: () => {
      if (expired) {
        throw new Error('PTY spawn preparation timed out before provider spawn')
      }
    },
    finish: () => {
      finished = true
      clear()
    },
    race: async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await Promise.race([operation, expiredPromise])
      } finally {
        clear()
      }
    }
  }
}
