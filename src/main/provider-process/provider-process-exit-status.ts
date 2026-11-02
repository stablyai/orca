import type { ProviderProcessExit } from './managed-provider-process'

/** How a provider process ended, e.g. `(signal SIGTERM)` or `(code 1)`; empty when nothing was observed. */
export function providerExitStatusText(exit: ProviderProcessExit | null): string {
  if (!exit) {
    return ''
  }
  if (exit.signal !== null) {
    return `(signal ${exit.signal})`
  }
  return exit.code === null ? '' : `(code ${exit.code})`
}
