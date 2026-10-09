import { captureError } from './recording-values'

let active = false

// Main's detached effects can reject without a caller promise; record that observable failure too.
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
      process.on('unhandledRejection', listener)
    }
  }
}
