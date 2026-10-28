import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import type { RelayHostReachability } from './relay-host-reachability'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

// Absorb brief wake/network failures before warning; keep unreachable aligned with the retry loop’s GIVE_UP_AFTER_ATTEMPTS.
// After a prior success, stale time distinguishes a changed/unreachable host from a transient drop.
const WARNING_ATTEMPTS = 3
const UNREACHABLE_ATTEMPTS = 12
const STALE_SINCE_LAST_CONNECT_MS = 60_000

// Repeated Tailscale endpoint failures can require a phone tunnel reset; show that remedy rather than assuming the host moved.
const TAILSCALE_HINT = 'check Tailscale'

// Relay verdicts describe the desktop directly; Tailscale advice would misdiagnose offline/signed-out hosts.
const RELAY_HOST_COPY: Record<
  Exclude<RelayHostReachability, 'connecting'>,
  { kind: 'warning' | 'unreachable'; label: (host: string) => string; detail: string }
> = {
  'signed-out': {
    kind: 'unreachable',
    label: (host) => `Sign-in required on ${host}`,
    detail: 'Sign in to Orca on your desktop to reconnect'
  },
  'host-offline': {
    kind: 'unreachable',
    label: (host) => `${host} is offline`,
    detail: "Check it's awake, Orca is running, and you're signed in"
  },
  // Re-pairing repairs refused credentials even when direct rotation is unavailable.
  'credential-refused': {
    kind: 'unreachable',
    label: (host) => `Relay access expired for ${host}`,
    detail: 'Re-pair with your desktop'
  },
  // Cell reachability failure says nothing about desktop health, so keep it amber.
  unreachable: {
    kind: 'warning',
    label: () => "Can't reach Relay",
    detail: 'Check your connection'
  }
}

export type ConnectionVerdict =
  | { kind: 'normal'; label: string }
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
  const hint = isTailscaleEndpoint(args.endpoint) ? TAILSCALE_HINT : undefined
  const host = args.hostName?.trim() || 'Host'
  const staleReason = lastConnectedAt == null ? 'never-connected' : 'stale'

  // An unrecognized pairing needs re-pairing, not more retries.
  if (state === 'auth-failed' || (args.pairingRejected && state !== 'connected')) {
    return { kind: 'auth-failed', label: 'Pairing invalid — re-pair with your desktop' }
  }

  if (state === 'connected') {
    return { kind: 'normal', label: 'Connected' }
  }

  // Revoked pairing outranks sign-in advice; explicit relay verdicts must survive a cleared pending path.
  const reachability = args.relayHostReachability ?? 'connecting'
  if (reachability !== 'connecting') {
    const copy = RELAY_HOST_COPY[reachability]
    return copy.kind === 'warning'
      ? { kind: 'warning', label: copy.label(host), detail: copy.detail }
      : { kind: 'unreachable', label: copy.label(host), reason: staleReason, detail: copy.detail }
  }

  // A stale pending path can outlive its retry timer; narrate relay only during dialing or recorded retry progress.
  if (args.pendingPath === 'relay' && (state !== 'disconnected' || reconnectAttempts > 0)) {
    if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
      if (lastConnectedAt == null) {
        return { kind: 'unreachable', label: "Can't connect via Relay", reason: 'never-connected' }
      }
      if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
        return { kind: 'unreachable', label: "Can't connect via Relay", reason: 'stale' }
      }
    }
    return { kind: 'normal', label: 'Connecting via Relay…' }
  }

  if (state === 'disconnected') {
    return { kind: 'normal', label: 'Disconnected' }
  }

  // Apply escalation through every redial state so failures cannot revert to Connecting during each attempt.
  if (reconnectAttempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'never-connected',
        hint
      }
    }
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      return {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'stale',
        hint
      }
    }
  }

  if (reconnectAttempts >= WARNING_ATTEMPTS) {
    return { kind: 'warning', label: "Can't connect", hint }
  }

  return { kind: 'normal', label: state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…' }
}

// Retries the user should hear about; auth-failed has its own re-pair remedy.
export function isConnectionOutage(
  verdict: ConnectionVerdict
): verdict is Extract<ConnectionVerdict, { kind: 'warning' | 'unreachable' }> {
  return verdict.kind === 'warning' || verdict.kind === 'unreachable'
}

// A normal label ending in an ellipsis is a dial still in progress.
export function isConnectionDialing(verdict: ConnectionVerdict): boolean {
  return verdict.kind === 'normal' && verdict.label.endsWith('…')
}

export function verdictDisplayLabel(verdict: ConnectionVerdict): string {
  if (isConnectionOutage(verdict) && verdict.hint) {
    return `${verdict.label} — ${verdict.hint}`
  }
  return verdict.label
}
