import { relayWebSocketOrigin } from '../relay-websocket-origin'

export function controlWebSocketUrl(cellUrl: string): { origin: string; url: string } {
  const websocketOrigin = relayWebSocketOrigin(cellUrl)
  return { origin: new URL(cellUrl).origin, url: `${websocketOrigin}/v1/host/control` }
}
