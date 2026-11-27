/** Calls `onInterrupt` with the signal's name; returns a function that stops listening. */
export type AuthInterruptSource = (onInterrupt: (signal: NodeJS.Signals) => void) => () => void

const INTERRUPTS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

// While listening, a signal no longer ends the process, so the command can cancel on the host first.
export const processInterrupts: AuthInterruptSource = (onInterrupt) => {
  for (const name of INTERRUPTS) {
    process.on(name, onInterrupt)
  }
  return () => {
    for (const name of INTERRUPTS) {
      process.off(name, onInterrupt)
    }
  }
}
