import {
  evaluateMobileWebBundleCompat,
  type MobileWebBundleCompatManifest
} from '../transport/mobile-web-bundle-compat'
import type {
  MobileWebShellBlockedVerdict,
  MobileWebShellGates,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

/** Shared because several transitions reach each of them, and two objects that are equal but not
 *  identical are two renders where the reducer meant one. */
export const CHECKING: MobileWebShellSessionState = { kind: 'checking' }
export const NATIVE_ROUTE: MobileWebShellSessionState = { kind: 'native-route' }

/**
 * Whether a gates change may start or restart the flow.
 *
 * Only from the two states still waiting on one. A displayed generation is not restarted by a
 * reconnect: the manifest check that would follow swaps the page out from under whoever is reading
 * it, and a cached generation stays valid until the route is entered again. A wall and a terminal
 * failure are both left by acting, so neither reacts either.
 */
export function awaitsGates(state: MobileWebShellSessionState): boolean {
  if (state.kind === 'failed') {
    // The one failure the gates can answer: a status that becomes readable is a different host
    // screen, and it costs nothing to take it rather than make someone walk back out.
    return state.reason === 'status-unreadable'
  }
  return state.kind === 'checking' || state.kind === 'offline'
}

/**
 * What the gates permit, before any manifest is read.
 *
 * One answer for both ways into the flow. A recovery used to keep whatever gates the `ready`
 * session was holding and go straight back to the manifest check, and gates that arrive while a
 * generation is on screen are stored without restarting: a reconnect whose status probe failed
 * therefore left a ready session carrying an unreadable status and an empty capability list, and
 * the next view failure walled the host as `bundle-unavailable` — terminal, no retry, about a host
 * that had simply not answered.
 */
export type MobileWebShellGateVerdict =
  /** Nothing is decidable yet. Two kinds rather than one so a dial that settles into a pending
   *  status still counts as a change worth restarting on. */
  | { readonly kind: 'dialling' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'status-unreadable' }
  /** The desktop ships no bundle, so it lists no page route and this one is the native screen's.
   *  Not a wall: a wall says the workspace cannot be opened, and here there is none to open. */
  | { readonly kind: 'native-route' }
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
  // Never a wall on an unreadable status: the empty capability list it leaves behind is
  // indistinguishable from a desktop that ships no bundle, and that wall tells the wrong story. It
  // is not a wait either — the gate settles closed and only re-asks in the background — so the one
  // honest answer is to say the status could not be read; a later readable status reopens it.
  if (!gates.statusReadable) {
    return { kind: 'status-unreadable' }
  }
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest: null
  })
  if (verdict.kind !== 'blocked') {
    return { kind: 'open' }
  }
  // `bundle-unavailable` is the only verdict reachable with no manifest, and it is the one block
  // that is not a wall: a desktop with no bundle declares no page route, so every route is native.
  return verdict.reason === 'bundle-unavailable'
    ? { kind: 'native-route' }
    : { kind: 'wall', verdict }
}

/**
 * The screen a gate verdict decides on its own, or null when it leaves the flow something to do.
 *
 * One mapping and two readers: the entry into the flow, and the fallback after a read the host
 * refused. A `fetching` session does not await the gates, so a refusal can land under a verdict the
 * flow never started on, and a second opinion taken there is how a host whose status had merely
 * gone unreadable would earn the wall the rule above exists to keep off it.
 *
 * Null for `offline` and `open` alike: both still have a cache behind them, and which of the two it
 * is decides only whether what comes out of it is judged against the host.
 */
export function gateState(
  verdict: MobileWebShellGateVerdict,
  retriedOnce: boolean
): MobileWebShellSessionState | null {
  switch (verdict.kind) {
    case 'native-route':
      return NATIVE_ROUTE
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

/**
 * The wall a generation already on disk earns against a host that can still be reached, or null
 * when it may be opened.
 *
 * Takes the verdict its caller already computed rather than deriving a second one, because the
 * distinction it turns on is the one `gateState` leaves open: `offline` keeps the rule that a host
 * nobody can reach cannot have moved past these bytes, and `open` is the only answer that leaves a
 * host to judge them against — this one has just replied, and an update exists precisely because it
 * moved, so bytes inside the window when they were written may be outside it now.
 */
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

/**
 * The gate verdict as one comparable value.
 *
 * A restart is worth taking only when this changes. The gates object is rebuilt on every status
 * refetch and every connection event, and most of those say exactly what the last one said: a
 * reconnect cycle that re-derives the same verdict used to re-sweep the staging tree and flip an
 * offline screen to a spinner and back for as long as the cycle ran.
 */
export function gateKey(gates: MobileWebShellGates): string {
  return gateVerdict(gates).kind
}
