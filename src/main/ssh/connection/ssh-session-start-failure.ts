// Errors from opening the SSH session itself, so a setup that never reached the host is not called a server failure.
const sessionStartFailures = new WeakSet<object>()

export function markSshSessionStartFailure<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    sessionStartFailures.add(error)
  }
  return error
}

/** Follows wrapping causes, as setup steps rethrow the dial's error inside their own. */
export function isSshSessionStartFailure(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if (sessionStartFailures.has(error)) {
    return true
  }
  return depth < 4 && error instanceof Error && isSshSessionStartFailure(error.cause, depth + 1)
}
