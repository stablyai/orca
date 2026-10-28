import {
  evaluateMobileWebBundleCompat,
  type MobileWebBundleCompatManifest
} from '../transport/mobile-web-bundle-compat'
import type {
  MobileWebShellBlockedVerdict,
  MobileWebShellGates,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

// Reuse state identities so equivalent transitions do not cause extra renders.
export const CHECKING: MobileWebShellSessionState = { kind: 'checking' }
export const ROUTE_UNAVAILABLE: MobileWebShellSessionState = { kind: 'route-unavailable' }

// Keep displayed generations stable through reconnects; only checking/offline and unreadable-status failures wait for new gates.
export function awaitsGates(state: MobileWebShellSessionState): boolean {
  if (state.kind === 'failed') {
    return state.reason === 'status-unreadable'
  }
  return state.kind === 'checking' || state.kind === 'offline'
}

// Use the same gate verdict for entry and recovery so unreadable status never masquerades as a desktop without bundle support.
export type MobileWebShellGateVerdict =
  // Distinguish dialling from pending status so settling the dial can restart the flow.
  | { readonly kind: 'dialling' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'status-unreadable' }
  | { readonly kind: 'wall'; readonly verdict: MobileWebShellBlockedVerdict }
  | { readonly kind: 'open' }

export function gateVerdict(gates: MobileWebShellGates): MobileWebShellGateVerdict {
  if (gates.reachability === 'connecting') {
    return { kind: 'dialling' }
  }
  if (gates.reachability === 'unreachable') {
    return { kind: 'offline' }
  }
  if (gates.statusPending) {
    return { kind: 'pending' }
  }
  // Empty capabilities after unreadable status do not prove missing bundle support; return a recoverable failure that readable status can reopen.
  if (!gates.statusReadable) {
    return { kind: 'status-unreadable' }
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest: null
  })
  return verdict.kind === 'blocked' ? { kind: 'wall', verdict } : { kind: 'open' }
}

// Share entry/refusal gate decisions: gates may change during fetching. Offline/open still consult cache; only open checks it against the host.
export function gateState(
  verdict: MobileWebShellGateVerdict,
  retriedOnce: boolean
): MobileWebShellSessionState | null {
  switch (verdict.kind) {
    case 'wall':
      return { kind: 'wall', verdict: verdict.verdict }
    case 'status-unreadable':
      return { kind: 'failed', reason: 'status-unreadable', retriedOnce }
    case 'dialling':
    case 'pending':
      return CHECKING
    case 'offline':
    case 'open':
      return null
  }
}

// Use the caller’s verdict: only a reachable, readable host can put cached bytes outside its compatibility window.
export function cachedGenerationWall(
  verdict: MobileWebShellGateVerdict,
  gates: MobileWebShellGates,
  manifest: MobileWebBundleCompatManifest
): MobileWebShellBlockedVerdict | null {
  if (verdict.kind !== 'open') {
    return null
  }
  const blocked = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest
  })
  return blocked.kind === 'blocked' ? blocked : null
}

// Compare verdicts instead of rebuilt gate objects so unchanged reconnect/status events cannot reread cache and flicker the spinner.
export function gateKey(gates: MobileWebShellGates): string {
  return gateVerdict(gates).kind
}
