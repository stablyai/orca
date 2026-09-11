import type { RpcResponse } from './types'

/**
 * Whether a desktop has told this phone it will not serve a Relay pairing RPC at all.
 *
 * Two codes mean the same thing here, and only one of them is reachable from an old desktop:
 *
 * - `method_not_found` — the method is on that desktop's mobile allowlist but nothing registers it
 *   (Relay compiled out, or the provider not wired).
 * - `forbidden` — the method is not on its mobile allowlist. The allowlist gate runs *before* the
 *   RPC dispatcher (`runtime-rpc-websocket-dispatch.ts`), so a method a desktop predates is absent
 *   from both and this is the only answer a phone can get from it. Keying the "too old for Relay,
 *   stay on LAN" fallback on `method_not_found` alone therefore never fired against the exact
 *   desktop the fallback exists for — first-time pairing threw instead of committing a LAN host.
 *
 * A desktop that does serve the probes allowlists them, so `forbidden` can only ever mean "this
 * desktop will not expose Relay pairing to a phone", which is what the caller falls back for.
 * See docs/reference/remote-wire-compatibility.md — a scope refusal is not a missing method.
 */
export function isPairingRelayRpcUnavailable(response: RpcResponse): boolean {
  return (
    !response.ok &&
    (response.error.code === 'method_not_found' || response.error.code === 'forbidden')
  )
}
