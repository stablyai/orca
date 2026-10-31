import { captureError } from './recording-values'

let active = false

// Record detached product rejections that have no caller promise.
export function recordUnhandledRejections(
  effect: (name: string, value: unknown) => void
): () => void {
  if (active) {
    throw new Error('Recordings must run sequentially in each process')
  }
  active = true
  const previous = process.rawListeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (error) => effect('unhandled-rejection', captureError(error)))
  return () => {
    active = false
    process.removeAllListeners('unhandledRejection')
    for (const listener of previous) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: raw listeners handle this event; preserve their wrappers so once listeners still fire once.
      process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener)
    }
  }
}
