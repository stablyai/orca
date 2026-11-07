import WebSocket from 'ws'
import { envProxyWsOptions } from '../../network/env-proxy-transport'
import { RELAY_HOST_CAPABILITY_HEADERS } from './relay-control-protocol'

export function createRelayControlSocket(url: string, token: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, ...RELAY_HOST_CAPABILITY_HEADERS },
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
    ...envProxyWsOptions(url)
  })
}
