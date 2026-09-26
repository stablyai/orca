/**
 * A launch whose terminal failed before its spawn was requested: nothing was created, so the
 * launch can settle as failed with its real cause instead of an unknown outcome.
 *
 * The original error is remembered rather than wrapped, so the caller still receives the host's own
 * code and message. After the request leaves this process a failure proves nothing — an SSH or
 * daemon spawn whose reply was lost may still have started — so only this earlier point counts.
 */

const notStartedFailures = new WeakSet<object>()

export function isAgentLaunchNotStarted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && notStartedFailures.has(error)
}

/** Watches one terminal create: `rethrow` marks a failure that came before the spawn request. */
export function trackTerminalSpawnDispatch(): {
  onPtySpawnDispatched: () => void
  rethrow: (error: unknown) => never
} {
  let dispatched = false
  return {
    onPtySpawnDispatched: () => {
      dispatched = true
    },
    rethrow: (error) => {
      if (!dispatched && typeof error === 'object' && error !== null) {
        notStartedFailures.add(error)
      }
      throw error
    }
  }
}
