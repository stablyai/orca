import type { Agent } from 'node:http'
import { getMainHttpClient } from './http-client'
import { SessionProxyAgent } from './session-proxy-agent'

// Off is the pre-setting path exactly: Node's global fetch and direct websockets.
let useProxy = false

/** Returns whether the route changed. */
export function setRelayAndCloudUseProxy(enabled: boolean): boolean {
  const changed = useProxy !== enabled
  useProxy = enabled
  return changed
}

/** Fetch for Orca Relay and Orca Cloud requests, honouring the "use proxy" setting. */
export function relayAndCloudFetch(url: string, init?: RequestInit): Promise<Response> {
  return useProxy ? getMainHttpClient().fetch(url, init) : globalThis.fetch(url, init)
}

/** ws `agent` for relay sockets; undefined keeps the direct connection. */
export function relayWebSocketAgent(url: string): Agent | undefined {
  const proxySession = useProxy ? getMainHttpClient().proxySession() : null
  // ws:// relay origins are loopback-only test/dev endpoints.
  return proxySession && url.startsWith('wss:') ? new SessionProxyAgent(proxySession) : undefined
}
