import { captureError } from './recording-values'

let active = false

// Record detached product rejections that have no caller promise.
export function recordUnhandledRejections(
  effect: (name: string, value: unknown) => void,
  onAcquired?: (restore: () => void) => void
): () => void {
  if (active) {
    throw new Error('Recordings must run sequentially in each process')
  }
  const previous = process.rawListeners('unhandledRejection')
  active = true
  const restore = () => {
    const errors: unknown[] = []
    try {
      process.removeAllListeners('unhandledRejection')
    } catch (error) {
      errors.push(error)
    }
    for (const listener of previous) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: raw listeners handle this event; preserve their wrappers so once listeners still fire once.
      try {
        process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener)
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      const actual = process.rawListeners('unhandledRejection')
      if (
        actual.length !== previous.length ||
        actual.some((entry, index) => entry !== previous[index])
      ) {
        errors.push(
          new Error('Recording unhandled listeners did not restore their actual baseline')
        )
      }
    } catch (error) {
      errors.push(error)
    }
    active = false
    if (errors.length === 1) {
      throw errors[0]
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Unhandled listener restoration failed')
    }
  }
  onAcquired?.(restore)
  try {
    process.removeAllListeners('unhandledRejection')
    process.on('unhandledRejection', (error) => effect('unhandled-rejection', captureError(error)))
  } catch (error) {
    if (!onAcquired) {
      try {
        restore()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Unhandled listener setup and rollback failed'
        )
      }
    }
    throw error
  }
  return restore
}
