import type { SecureContext } from 'node:tls'
import WebSocket from 'ws'
import { getFirstPartySecureContext } from './first-party-tls-trust'

export function prepareFirstPartyRelayWebSocketTrust(url: string): void {
  if (url.startsWith('wss:')) {
    getFirstPartySecureContext()
  }
}

function firstPartyWebSocketTlsOptions(url: string): { secureContext: SecureContext } | undefined {
  if (!url.startsWith('wss:')) {
    return undefined
  }
  return { secureContext: getFirstPartySecureContext() }
}

export function createFirstPartyRelayControlWebSocket(url: string, relayJwt: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${relayJwt}` },
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
    ...firstPartyWebSocketTlsOptions(url)
  })
}

export function createFirstPartyRelayDataWebSocket(url: string): WebSocket {
  return new WebSocket(url, {
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
    ...firstPartyWebSocketTlsOptions(url)
  })
}
