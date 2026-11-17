import WebSocket from 'ws'
import { RELAY_HOST_CAPABILITY_HEADERS } from './relay-control-protocol'

export function createRelayControlSocket(url: string, relayJwt: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${relayJwt}`, ...RELAY_HOST_CAPABILITY_HEADERS },
    perMessageDeflate: false,
    maxPayload: 64 * 1024
  })
}
