import { describeRelayFailure } from './relay-error-redaction.js'

type Warn = (message: string) => void

// A swallowed error hides which sweep step is failing (a silently dead
// cleanup chain stalled production rehoming for hours).
export async function runRelayBackgroundOperation(
  operation: () => Promise<unknown>,
  failureMessage: string,
  warn: Warn = console.warn
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    // Dependency outages must fail readiness without crashing liveness.
    warn(`${failureMessage}: ${describeRelayFailure(error)}`)
  }
}
