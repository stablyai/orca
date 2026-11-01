import type { RpcFailure, RpcResponse } from './types'

// Old hosts refuse at the mobile allowlist before dispatch, so unavailable pairing probes can answer forbidden.
// Retain method_not_found compatibility if dispatch ordering changes; callers may then commit LAN-only and retire pending secrets.
// Intersect the failure type so a false result does not narrow unrelated refusal codes to RpcSuccess.
export function isPairingRelayRpcUnavailable(
  response: RpcResponse
): response is RpcFailure & { error: { code: 'method_not_found' | 'forbidden' } } {
  return (
    !response.ok &&
    (response.error.code === 'method_not_found' || response.error.code === 'forbidden')
  )
}
