import type { RpcFailure, RpcResponse } from './types'

/**
 * Whether a desktop has told this phone it will not serve a Relay pairing RPC at all.
 *
 * `forbidden` is the code an old desktop actually sends. The mobile allowlist gate runs *before*
 * the RPC dispatcher (`runtime-rpc-websocket-dispatch.ts`), so a method a desktop predates is
 * absent from both lists and the gate answers first, never the dispatcher. The phone's own Files
 * and Git fallbacks have read both codes for exactly this reason since they shipped
 * (`isMobileMethodUnavailableError`, `isMobileGitUnavailable`); the two Relay pairing probes were
 * the ones left keyed on absence alone, so their "too old for Relay, stay on LAN" fallback could
 * not fire against the desktop it exists for.
 *
 * Where that bit: `upgradeDirectMobileRelay`, which re-probes every LAN-only host on each
 * reconnect. Against an old desktop the refusal fell through to `interpret`, threw, and the
 * controller swallowed it — so the upgrade journal written just above, holding a 32-byte pending
 * resume secret, was never cleared. Being write-once it was then re-read, never used and never
 * retired, for the life of the pairing. The pre-profile coordinator is the defensive site:
 * a desktop old enough to lack these methods also lacks the `relay` block in its QR offer, so that
 * flow already commits a LAN host without probing. It hardens the case of a desktop that offers
 * relay but does not allowlist the probe to a phone — a skew this codebase has seen on other
 * methods, which is what both fallbacks above were written for.
 *
 * `method_not_found` is kept because it is this fallback's pre-existing contract, not because a
 * shipped desktop sends it: `mobile-rpc-allowlist.test.ts` requires every method the phone calls to
 * be both allowlisted and registered, so the allowlisted-but-unregistered case cannot ship. The arm
 * is what keeps the fallback right if the gate ever stops answering first.
 *
 * See docs/reference/remote-wire-compatibility.md — a scope refusal is not a missing method.
 */
// Why the intersection rather than `RpcFailure`: a plain failure guard would narrow the *false*
// branch to `RpcSuccess`, and a refusal carrying any other code still reaches it.
export function isPairingRelayRpcUnavailable(
  response: RpcResponse
): response is RpcFailure & { error: { code: 'method_not_found' | 'forbidden' } } {
  return (
    !response.ok &&
    (response.error.code === 'method_not_found' || response.error.code === 'forbidden')
  )
}
