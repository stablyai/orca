// Keys whose last check outlived its deadline and has not settled yet.
const stalledKeys = new Set<string>()

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
  stalledKeys.add(key)
  void running.catch(() => {}).finally(() => stalledKeys.delete(key))
  return fallback
}
