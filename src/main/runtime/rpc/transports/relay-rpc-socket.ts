import WebSocket from 'ws'
import { envProxyWsOptions } from '../../../network/env-proxy-transport'

const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024

/** Default CloudRelayTransport socket: no compression, 1 MiB frames, and the env proxy when one applies. */
export function createRelayRpcSocket(url: string): WebSocket {
  return new WebSocket(url, {
    perMessageDeflate: false,
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    ...envProxyWsOptions(url)
  })
}
