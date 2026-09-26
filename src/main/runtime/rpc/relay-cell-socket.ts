import type { Agent } from 'node:http'
import WebSocket from 'ws'
import { outboundProxySocketAgent } from '../../network/outbound-proxy'

const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024

/**
 * Dials one cell data socket. The app's configured proxy covers these sockets too, so the
 * resolved agent is attached when there is one. `isCurrent` is re-checked after that
 * resolution, which is where an open that stop() or a newer attempt superseded is dropped
 * before it can produce a socket. An injected factory elsewhere owns its own transport and
 * never reaches here.
 */
export async function dialRelayCellSocket(
  url: string,
  isCurrent: () => boolean
): Promise<WebSocket> {
  const agent: Agent | undefined = await outboundProxySocketAgent(url)
  if (!isCurrent()) {
    throw new Error('relay_transport_stopped')
  }
  return new WebSocket(url, {
    perMessageDeflate: false,
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    ...(agent ? { agent } : {})
  })
}
