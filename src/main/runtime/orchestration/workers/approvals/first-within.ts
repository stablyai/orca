// Why 3 s: Claude records a hook's answer at once (probe F2); longer means it was not taken.
const WAIT_MS = 3_000
const RETRY_MS = 100

/** The first non-null `read` within the wait, retried on `setTimer`; null when none came. */
export function firstWithin<T>(
  setTimer: (run: () => void, delayMs: number) => unknown,
  read: () => T | null | Promise<T | null>
): Promise<T | null> {
  return new Promise((resolve) => {
    let waited = 0
    const check = async (): Promise<void> => {
      // A read that throws has no value yet; a rejection must not leave the wait unsettled.
      const value = await Promise.resolve()
        .then(read)
        .catch(() => null)
      if (value !== null || waited >= WAIT_MS) {
        resolve(value)
        return
      }
      waited += RETRY_MS
      setTimer(() => void check(), RETRY_MS)
    }
    void check()
  })
}
