import type { RelayRecoveryLog } from './mobile-relay-recovery-log'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'

export function logRelayConnected(log: RelayRecoveryLog): void {
  log('runtime channel migrated to relay', undefined, {
    level: 'success',
    code: 'relay-connected'
  })
}

export function logRelayDialFailure(
  log: RelayRecoveryLog,
  error: Error | null,
  source: 'dial' | 'active-session' = 'dial'
): void {
  if (!error) {
    return
  }
  const base = `${error.name}: ${String(error.message).slice(0, 80)}`
  const detail =
    error instanceof RelayDirectorHttpError && error.retryAfterMs != null
      ? `${base}; retry-after=${error.retryAfterMs}ms`
      : base
  log(source === 'dial' ? 'relay dial failed' : 'active relay session failed', detail, {
    level: 'error',
    code: source === 'dial' ? 'relay-dial-failed' : 'relay-session-failed'
  })
}

export function logRelayCredentialUnavailable(log: RelayRecoveryLog, hasBundle: boolean): void {
  log(
    hasBundle
      ? 'relay credential expired or rejected; slow reprobe armed'
      : 'no relay credential bundle; slow reprobe armed',
    undefined,
    { level: 'warn', code: 'relay-credential-unavailable' }
  )
}
