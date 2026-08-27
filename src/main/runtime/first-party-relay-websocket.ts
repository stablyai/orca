import type { SecureContext } from 'node:tls'
import WebSocket from 'ws'
import { getFirstPartySecureContext } from '../network/first-party-tls-trust'

let secureContext: SecureContext | undefined

export async function prepareFirstPartyRelayWebSocketTrust(url: string): Promise<void> {
  if (url.startsWith('wss:')) {
    secureContext ??= await getFirstPartySecureContext()
  }
}

function firstPartyWebSocketTlsOptions(
  url: string
): { secureContext: SecureContext; rejectUnauthorized: true } | undefined {
  if (!url.startsWith('wss:')) {
    return undefined
  }
  if (!secureContext) {
    throw new Error('first_party_websocket_trust_not_prepared')
  }
  return { secureContext, rejectUnauthorized: true }
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
