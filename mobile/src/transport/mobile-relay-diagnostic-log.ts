import type { RelayRecoveryLog } from './mobile-relay-recovery-log'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'

export function logRelayConnected(log: RelayRecoveryLog): void {
  log('runtime channel migrated to relay', undefined, {
    level: 'success',
    code: 'relay-connected'
  })
}

// Which credential the dial used, so a log can show whether failures cluster on one
// credential while a later attempt with another succeeds. The version is an integer
// counter, never the token itself.
export type RelayDialAttemptContext = {
  credentialVersion: number
  attempt: number
  totalCredentials: number
}

/**
 * Records a relay dial or active-session failure on the recovery log, appending the
 * director's retry-after when present and the dialed credential when `context` is given.
 */
export function logRelayDialFailure(
  log: RelayRecoveryLog,
  error: Error | null,
  source: 'dial' | 'active-session' = 'dial',
  context?: RelayDialAttemptContext
): void {
  if (!error) {
    return
  }
  const base = `${error.name}: ${String(error.message).slice(0, 80)}`
  const withRetryAfter =
    error instanceof RelayDirectorHttpError && error.retryAfterMs != null
      ? `${base}; retry-after=${error.retryAfterMs}ms`
      : base
  const detail = context
    ? `${withRetryAfter}; credential=v${context.credentialVersion} (${context.attempt}/${context.totalCredentials})`
    : withRetryAfter
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
