import type { ProxySession } from './electron-default-proxy-session'
import { getElectronProxyCredentialsForSession } from './electron-proxy-credentials'

const PROXY_SCHEMES: Record<string, string> = {
  PROXY: 'http:',
  HTTP: 'http:',
  HTTPS: 'https:',
  SOCKS: 'socks4:',
  SOCKS4: 'socks4:',
  SOCKS5: 'socks5h:'
}

export async function resolveSessionProxy(session: ProxySession, target: string): Promise<string> {
  const [route] = (await session.resolveProxy(target)).split(';')
  if (route?.trim() === 'DIRECT') {
    return ''
  }
  const [kind, address] = route?.trim().split(/\s+/) ?? []
  const scheme = kind ? PROXY_SCHEMES[kind] : undefined
  if (!scheme || !address) {
    throw new Error('Unsupported proxy route')
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
