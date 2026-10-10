import { ProxyAgent } from 'proxy-agent'
import WebSocket, { type ClientOptions } from 'ws'
import { defaultProxySession, type ProxySession } from './electron-default-proxy-session'
import { getElectronProxyCredentialsForSession } from './electron-proxy-credentials'
import { awaitProxySessionApplication } from './proxy-settings'
import { trackProxySessionWebSocket } from './proxy-session-websockets'

const PROXY_SCHEMES: Record<string, string> = {
  PROXY: 'http:',
  HTTP: 'http:',
  HTTPS: 'https:',
  SOCKS: 'socks4:',
  SOCKS4: 'socks4:',
  SOCKS5: 'socks5h:'
}

async function resolveWebSocketProxy(session: ProxySession, target: string): Promise<string> {
  const [route] = (await session.resolveProxy(target)).split(';')
  if (route?.trim() === 'DIRECT') {
    return ''
  }
  const [kind, address] = route?.trim().split(/\s+/) ?? []
  const scheme = kind ? PROXY_SCHEMES[kind] : undefined
  if (!scheme || !address) {
    throw new Error('Unsupported WebSocket proxy route')
  }
  const proxy = new URL(`${scheme}//${address}`)
  const credentials = getElectronProxyCredentialsForSession(session)
  const port = Number(proxy.port || (scheme === 'http:' ? 80 : scheme === 'https:' ? 443 : 1080))
  if (
    credentials &&
    credentials.host === proxy.hostname.replace(/^\[|\]$/g, '').toLowerCase() &&
    credentials.port === port
  ) {
    proxy.username = encodeURIComponent(credentials.username)
    proxy.password = encodeURIComponent(credentials.password)
  }
  return proxy.toString()
}

export function createProxyWebSocket(url: string, options: ClientOptions): WebSocket {
  const session = defaultProxySession()
  if (!session) {
    return new WebSocket(url, options)
  }
  const agent = new ProxyAgent({
    getProxyForUrl: async (target, request) => {
      if (!(await awaitProxySessionApplication(session))) {
        throw new Error('Proxy settings are not ready')
      }
      if (request.destroyed) {
        throw new Error('WebSocket connection cancelled')
      }
      trackProxySessionWebSocket(session, socket)
      const proxy = await resolveWebSocketProxy(session, target)
      if (request.destroyed) {
        throw new Error('WebSocket connection cancelled')
      }
      return proxy
    }
  })
  const socket = new WebSocket(url, { ...options, agent })
  socket.once('close', () => agent.destroy())
  return socket
}
