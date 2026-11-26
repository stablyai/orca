import { AsyncLocalStorage } from 'node:async_hooks'

// The expiry signal of the check whose work is running, so every file read in it can tell it was abandoned.
const activeCheck = new AsyncLocalStorage<AbortSignal>()

/** Throws once the check this runs under has expired, so late work stops at the next read. */
export function throwIfCheckExpired(): void {
  if (activeCheck.getStore()?.aborted) {
    throw new Error('Branch check abandoned')
  }
}

/** Runs one file operation for a check: nothing starts once the check expired, and a late result goes no further. */
export async function checkedIo<T>(io: () => Promise<T>): Promise<T> {
  throwIfCheckExpired()
  const result = await io()
  throwIfCheckExpired()
  return result
}

// Per key, how many checks outlived their deadline and have not settled yet.
const stalledKeys = new Map<string, number>()

export function waitAtMost<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

/** Runs a file-based check with a deadline; past it, answers `fallback`, tells the check to stop, and answers `fallback` at once for `key` until that check settles, so a stalled disk holds one check per key. */
export async function checkWithDeadline<T>(
  key: string,
  timeoutMs: number,
  fallback: T,
  check: (stop: () => boolean, signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (stalledKeys.has(key)) {
    return fallback
  }
  // Aborted at expiry: queued Git aborts, and reads check it before starting.
  const expiry = new AbortController()
  const running = activeCheck.run(expiry.signal, () =>
    check(() => expiry.signal.aborted, expiry.signal)
  )
  const expired = Symbol('expired')
  let timer: ReturnType<typeof setTimeout> | undefined
  const answer = await Promise.race([
    running,
    new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
  if (answer !== expired) {
    return answer
  }
  expiry.abort()
  stalledKeys.set(key, (stalledKeys.get(key) ?? 0) + 1)
  void running
    .catch(() => {})
    .finally(() => {
      const left = (stalledKeys.get(key) ?? 1) - 1
      if (left > 0) {
        stalledKeys.set(key, left)
      } else {
        stalledKeys.delete(key)
      }
    })
  return fallback
}
