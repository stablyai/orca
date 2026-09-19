import { evaluateMobileWebBundleCompat } from '../transport/mobile-web-bundle-compat'
import type {
  MobileWebShellBlockedVerdict,
  MobileWebShellGates,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

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
  // is not a wait either — the gate settles once per host screen and does not probe again — so the
  // one honest answer is to say the status could not be read and let a fresh gate reopen it.
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
