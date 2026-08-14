import { OrchestrationError } from './orchestration-error'

export const FEDERATION_TERMINAL_RECOVERY_BASE_DELAY_MS = 1_000
export const FEDERATION_TERMINAL_RECOVERY_MAX_DELAY_MS = 30_000

const TERMINAL_ERROR_CODES = new Set([
  'dispatch_not_found',
  'environment_not_found',
  'peer_changed'
])

export type FederationTerminalRecoveryFailure = {
  errorCode: string | null
  terminal: boolean
}

export function classifyFederationTerminalRecoveryFailure(
  error: unknown
): FederationTerminalRecoveryFailure {
  const errorCode = error instanceof OrchestrationError ? error.code : null
  return { errorCode, terminal: errorCode !== null && TERMINAL_ERROR_CODES.has(errorCode) }
}

export function getFederationTerminalRecoveryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30))
  return Math.min(
    FEDERATION_TERMINAL_RECOVERY_BASE_DELAY_MS * 2 ** exponent,
    FEDERATION_TERMINAL_RECOVERY_MAX_DELAY_MS
  )
}
