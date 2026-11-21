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
  check: (stop: () => boolean) => Promise<T>
): Promise<T> {
  if (stalledKeys.has(key)) {
    return fallback
  }
  let expired = false
  const running = check(() => expired)
  const expiry = Symbol('expired')
  let timer: ReturnType<typeof setTimeout> | undefined
  const answer = await Promise.race([
    running,
    new Promise<typeof expiry>((resolve) => {
      timer = setTimeout(() => resolve(expiry), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
  if (answer !== expiry) {
    return answer
  }
  expired = true
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
