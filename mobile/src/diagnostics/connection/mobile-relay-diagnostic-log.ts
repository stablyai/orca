import { RelayOuterError } from '../../transport/encryption/mobile-relay-e2ee-link'
import type { RelayRecoveryLog } from './mobile-relay-recovery-log'
import { isExplicitCredentialRejection } from '../../transport/relay/relay-credential-eligibility'
import { RelayDirectorHttpError } from '../../transport/relay/mobile-relay-resume-director'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from '../../transport/connection/stable-logical-rpc-client'

// One line per client open so a host that never dials relay still says why: no relay routing, or credentials missing.
export function logRelaySupervisorStarted(
  log: RelayRecoveryLog,
  logical: Pick<StableLogicalRpcClient, 'getState'>,
  bundle: MobileRelayCredentialBundle | null
): void {
  log(
    'relay fallback ready',
    `direct=${logical.getState()} credentials=${bundle ? 'saved' : 'missing; recovery will re-read'}`
  )
}

export function logRelayRoutingMissing(log: RelayRecoveryLog): void {
  log('no relay routing saved for this host; relay is offered only after a direct connection')
}

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
  const credentialRejected = isExplicitCredentialRejection(error)
  const base = `${error.name}: ${String(error.message).slice(0, 80)}${credentialRejected ? ' (relay-hello refusal)' : ''}`
  const detail =
    error instanceof RelayDirectorHttpError && error.retryAfterMs != null
      ? `${base}; retry-after=${error.retryAfterMs}ms`
      : base
  log(source === 'dial' ? 'relay dial failed' : 'active relay session failed', detail, {
    level: 'error',
    code: source === 'dial' ? 'relay-dial-failed' : 'relay-session-failed',
    ...(error instanceof RelayOuterError ? { relayCloseCode: error.code } : {}),
    ...(credentialRejected ? { relayCredentialRejected: true } : {})
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
