import type { ProviderProcessExit } from './managed-provider-process'
import { findInErrorChain } from './provider-error-chain'

/** Retain missing wait status through adapter errors without inventing a CLI outcome. */
export function withLostProviderOutcome<T extends Error>(
  error: T,
  status: { readonly outcomeLost?: boolean } | null | undefined
): T {
  return status?.outcomeLost ? Object.assign(error, { providerOutcomeLost: true }) : error
}

export function providerOutcomeLost(error: unknown): boolean {
  return (
    findInErrorChain(error, (inner) =>
      'providerOutcomeLost' in inner && inner.providerOutcomeLost === true ? true : undefined
    ) === true
  )
}

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
