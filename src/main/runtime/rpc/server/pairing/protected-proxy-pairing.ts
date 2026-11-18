import { normalizePairingUrl } from '../../../../../shared/network/pairing-url'
import { classifyRemotePairingHostname } from '../../../../../shared/remote-runtime/pairing/remote-pairing-address'

export const PROTECTED_PROXY_PAIRING_GUIDANCE =
  '--preserve-bind requires a pinned loopback listener and an explicit HTTPS/WSS reverse-proxy address, without Relay. Configure and verify the proxy authentication separately.'

export function canPreservePairingBind(bindHost: string, address?: string | null): boolean {
  if (classifyRemotePairingHostname(bindHost) !== 'loopback' || !address) {
    return false
  }
  const normalized = normalizePairingUrl(address)
  if (!normalized) {
    return false
  }
  const endpoint = new URL(normalized)
  return (
    endpoint.protocol === 'wss:' &&
    !endpoint.search &&
    classifyRemotePairingHostname(endpoint.hostname) !== 'loopback'
  )
}
