import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import { translate } from '../i18n/mobile-i18n'
import type { RelayHostReachability } from './relay-host-reachability'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

// Absorb brief wake/network failures before warning; keep unreachable aligned with the retry loop’s GIVE_UP_AFTER_ATTEMPTS.
// After a prior success, stale time distinguishes a changed/unreachable host from a transient drop.
const WARNING_ATTEMPTS = 3
const UNREACHABLE_ATTEMPTS = 12
const STALE_SINCE_LAST_CONNECT_MS = 60_000

// Relay verdicts describe the desktop directly; Tailscale advice would misdiagnose offline/signed-out hosts.
function relayHostCopy(): Record<
  Exclude<RelayHostReachability, 'connecting'>,
  { kind: 'warning' | 'unreachable'; label: (host: string) => string; detail: string }
> {
  return {
    'signed-out': {
      kind: 'unreachable',
      label: (host) =>
        translate('connection.connectionHealth.signInRequired', 'Sign-in required on {{host}}', {
          host
        }),
      detail: translate(
        'connection.connectionHealth.signInDetail',
        'Sign in to Orca on your desktop to reconnect'
      )
    },
    'host-offline': {
      kind: 'unreachable',
      label: (host) =>
        translate('connection.connectionHealth.hostOffline', '{{host}} is offline', { host }),
      detail: translate(
        'connection.connectionHealth.hostOfflineDetail',
        "Check it's awake, Orca is running, and you're signed in"
      )
    },
    // Re-pairing repairs refused credentials even when direct rotation is unavailable.
    'credential-refused': {
      kind: 'unreachable',
      label: (host) =>
        translate(
          'connection.connectionHealth.relayAccessExpired',
          'Relay access expired for {{host}}',
          {
            host
          }
        ),
      detail: translate('connection.connectionHealth.rePairDetail', 'Re-pair with your desktop')
    },
    // Cell reachability failure says nothing about desktop health, so keep it amber.
    unreachable: {
      kind: 'warning',
      label: () => translate('connection.connectionHealth.relayUnreachable', "Can't reach Relay"),
      detail: translate('connection.connectionHealth.checkConnection', 'Check your connection')
    }
  }
}

export type ConnectionVerdict =
  | { kind: 'normal'; label: string; dialing?: boolean }
  | { kind: 'warning'; label: string; hint?: string; detail?: string }
  | {
      kind: 'unreachable'
      label: string
      reason: 'never-connected' | 'stale'
      hint?: string
      // A second line the row renders under the label; the label alone must still stand.
      detail?: string
    }
  | { kind: 'auth-failed'; label: string }

// Recompute staleness against now; lastConnectedAt itself is a fixed timestamp.
export function classifyConnection(args: {
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  // A pinned endpoint enables Tailscale-specific hints.
  endpoint?: string | null
  pendingPath?: MobileConnectionPath | null
  // Credential refusal needs re-pairing and outranks connecting state.
  pairingRejected?: boolean
  // Explicit relay evidence outranks retry-count inference; connecting means no verdict yet.
  relayHostReachability?: RelayHostReachability
  // Include host identity because header labels can appear without a row title.
  hostName?: string
  nowMs?: number
}): ConnectionVerdict {
  const { state, reconnectAttempts, lastConnectedAt } = args
  const now = args.nowMs ?? Date.now()
  const hint = isTailscaleEndpoint(args.endpoint)
    ? translate('connection.connectionHealth.tailscaleHint', 'check Tailscale')
    : undefined
  const host =
    args.hostName?.trim() || translate('connection.connectionHealth.hostFallback', 'Host')
  const staleReason = lastConnectedAt == null ? 'never-connected' : 'stale'

  // An unrecognized pairing needs re-pairing, not more retries.
  if (state === 'auth-failed' || (args.pairingRejected && state !== 'connected')) {
    return {
      kind: 'auth-failed',
      label: translate(
        'connection.connectionHealth.pairingInvalid',
        'Pairing invalid — re-pair with your desktop'
      )
    }
  }

  if (state === 'connected') {
    return {
      kind: 'normal',
      label: translate('connection.connectionHealth.connected', 'Connected')
    }
  }

  // Revoked pairing outranks sign-in advice; explicit relay verdicts must survive a cleared pending path.
  const reachability = args.relayHostReachability ?? 'connecting'
  if (reachability !== 'connecting') {
    const copy = relayHostCopy()[reachability]
    return copy.kind === 'warning'
      ? { kind: 'warning', label: copy.label(host), detail: copy.detail }
      : { kind: 'unreachable', label: copy.label(host), reason: staleReason, detail: copy.detail }
  }

  // A stale pending path can outlive its retry timer; narrate relay only during dialing or recorded retry progress.
  if (args.pendingPath === 'relay' && (state !== 'disconnected' || reconnectAttempts > 0)) {
    if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
      if (lastConnectedAt == null) {
        return {
          kind: 'unreachable',
          label: translate(
            'connection.connectionHealth.relayConnectFailed',
            "Can't connect via Relay"
          ),
          reason: 'never-connected'
        }
      }
      if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
        return {
          kind: 'unreachable',
          label: translate(
            'connection.connectionHealth.relayConnectFailed',
            "Can't connect via Relay"
          ),
          reason: 'stale'
        }
      }
    }
    return {
      kind: 'normal',
      label: translate('connection.connectionHealth.connectingViaRelay', 'Connecting via Relay…'),
      dialing: true
    }
  }

  if (state === 'disconnected') {
    return {
      kind: 'normal',
      label: translate('connection.connectionHealth.disconnected', 'Disconnected')
    }
  }

  // Apply escalation through every redial state so failures cannot revert to Connecting during each attempt.
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: 'unreachable',
        label: translate('connection.connectionHealth.desktopUnreachable', "Can't reach desktop"),
        reason: 'never-connected',
        hint
      }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: 'unreachable',
        label: translate('connection.connectionHealth.desktopUnreachable', "Can't reach desktop"),
        reason: 'stale',
        hint
      }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return {
      kind: 'warning',
      label: translate('connection.connectionHealth.connectFailed', "Can't connect"),
      hint
    }
  }

  return {
    kind: 'normal',
    label:
      state === 'reconnecting'
        ? translate('connection.connectionHealth.reconnecting', 'Reconnecting…')
        : translate('connection.connectionHealth.connecting', 'Connecting…'),
    dialing: true
  }
}

// Retries the user should hear about; auth-failed has its own re-pair remedy.
export function isConnectionOutage(
  verdict: ConnectionVerdict
): verdict is Extract<ConnectionVerdict, { kind: 'warning' | 'unreachable' }> {
  return verdict.kind === 'warning' || verdict.kind === 'unreachable'
}

export function isConnectionDialing(verdict: ConnectionVerdict): boolean {
  return verdict.kind === 'normal' && verdict.dialing === true
}

export function verdictDisplayLabel(verdict: ConnectionVerdict): string {
  if (isConnectionOutage(verdict) && verdict.hint) {
    return translate('connection.connectionHealth.labelWithHint', '{{label}} — {{hint}}', {
      label: verdict.label,
      hint: verdict.hint
    })
  }
  return verdict.label
}
