// Why: will-quit defers app.quit() until teardown settles. Teardown members
// are individually bounded, but a wedged transport (half-open post-sleep
// socket) can leave one unsettled forever and make Force Quit the only way
// out (#9447). Racing a deadline guarantees quit always completes.

// Why: generous enough for daemon checkpoint writes on a slow disk; small
// enough that a wedged teardown never needs Force Quit.
export const WILL_QUIT_TEARDOWN_DEADLINE_MS = 20_000

export type NamedQuitTeardown = {
  name: string
  promise: Promise<unknown>
}

export async function settleTeardownWithinDeadline(
  teardowns: readonly NamedQuitTeardown[],
  deadlineMs: number = WILL_QUIT_TEARDOWN_DEADLINE_MS
): Promise<string[]> {
  const pendingNames = new Set(teardowns.map(({ name }) => name))
  const settled = Promise.allSettled(
    teardowns.map(({ name, promise }) =>
      promise.finally(() => {
        pendingNames.delete(name)
      })
    )
  ).then(() => 'settled' as const)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs)
    timer.unref?.()
  })
  const outcome = await Promise.race([settled, deadline])
  clearTimeout(timer)
  return outcome === 'deadline' ? [...pendingNames] : []
}

/**
 * Resolves to the settled value, or `null` once `timeoutMs` elapses. Why null rather than a throw:
 * every quit-path teardown is best-effort, and a rejection here would have to be caught at each
 * call site anyway. The timer is unref'd so it can never itself hold the process open.
 */
export async function settleWithinMs<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
