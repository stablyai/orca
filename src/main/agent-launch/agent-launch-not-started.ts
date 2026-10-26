/**
 * Only pre-dispatch failure proves no spawn occurred; rethrow the original error.
 * Track per launch because concurrent creates may reject with the same error object.
 */
export type TerminalSpawnDispatch = {
  onPtySpawnDispatched: () => void
  rethrow: (error: unknown) => never
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
