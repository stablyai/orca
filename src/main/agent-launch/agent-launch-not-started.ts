/**
 * A launch whose terminal failed before its spawn was requested: nothing was created, so the
 * launch can settle as failed with its real cause instead of an unknown outcome.
 *
 * The original error is remembered rather than wrapped, so the caller still receives the host's own
 * code and message. After the request leaves this process a failure proves nothing — an SSH or
 * daemon spawn whose reply was lost may still have started — so only this earlier point counts.
 *
 * The verdict belongs to the launch, not to the error object: a failed pane spawn rejects the same
 * error into the spawner (after its request left) and into a concurrent create waiting on that pane
 * (before its own request left), so a mark on the error itself would clear both.
 */
export type TerminalSpawnDispatch = {
  onPtySpawnDispatched: () => void
  /** Rethrows the create's failure, remembering it when the spawn request had not yet left. */
  rethrow: (error: unknown) => never
  /** True only for the error this launch's create threw before its spawn request left. */
  failedBeforeDispatch: (error: unknown) => boolean
}

export function trackTerminalSpawnDispatch(): TerminalSpawnDispatch {
  let dispatched = false
  let notStarted: { error: unknown } | undefined
  return {
    onPtySpawnDispatched: () => {
      dispatched = true
    },
    rethrow: (error) => {
      if (!dispatched) {
        notStarted = { error }
      }
      throw error
    },
    failedBeforeDispatch: (error) =>
      !dispatched && notStarted !== undefined && notStarted.error === error
  }
}
