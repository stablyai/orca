import { normalizeProxyUrl } from '../../shared/network-proxy'

export type ElectronProxyCredentials = {
  host: string
  port: number
  username: string
  password: string
}

export type ElectronProxyConfig = {
  proxyRules: string
  credentials: ElectronProxyCredentials | null
}

const DEFAULT_PROXY_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'socks:': 1080,
  'socks4:': 1080,
  'socks5:': 1080
}

let proxyCredentialsBySession = new WeakMap<object, ElectronProxyCredentials>()

function decodeProxyCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeProxyHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase()
}

export function separateElectronProxyCredentials(proxyUrl: string): ElectronProxyConfig {
  const url = new URL(proxyUrl)
  const hasCredentials = Boolean(url.username || url.password)
  const credentials = hasCredentials
    ? {
        host: normalizeProxyHost(url.hostname),
        port: url.port ? Number(url.port) : (DEFAULT_PROXY_PORTS[url.protocol] ?? 0),
        username: decodeProxyCredential(url.username),
        password: decodeProxyCredential(url.password)
      }
    : null
  url.username = ''
  url.password = ''
  const normalized = normalizeProxyUrl(url.toString())
  return { proxyRules: normalized.ok ? normalized.value : '', credentials }
}

export function haveSameElectronProxyCredentials(
  left: ElectronProxyCredentials | null,
  right: ElectronProxyCredentials | null
): boolean {
  return (
    left?.host === right?.host &&
    left?.port === right?.port &&
    left?.username === right?.username &&
    left?.password === right?.password
  )
}

export function setElectronProxyCredentialsForSession(
  proxySession: object,
  credentials: ElectronProxyCredentials | null
): void {
  if (credentials) {
    proxyCredentialsBySession.set(proxySession, credentials)
  } else {
    proxyCredentialsBySession.delete(proxySession)
  }
}

export function clearElectronProxyCredentialsForSession(proxySession: object): void {
  proxyCredentialsBySession.delete(proxySession)
}

export function resetElectronProxyCredentialsForTests(proxySession?: object): void {
  if (proxySession) {
    clearElectronProxyCredentialsForSession(proxySession)
  } else {
    proxyCredentialsBySession = new WeakMap()
  }
}

export function handleElectronProxyLogin(
  event: { preventDefault(): void },
  webContents: { session: object } | null,
  _authenticationResponseDetails: unknown,
  authInfo: { isProxy: boolean; host: string; port: number; scheme?: string; realm?: string },
  callback: (username?: string, password?: string) => void,
  defaultProxySession?: object
): void {
  if (!authInfo.isProxy) {
    return
  }
  const proxySession = webContents?.session ?? defaultProxySession
  if (!proxySession) {
    return
  }
  const credentials = proxyCredentialsBySession.get(proxySession)
  if (
    !credentials ||
    credentials.host !== normalizeProxyHost(authInfo.host) ||
    credentials.port !== authInfo.port
  ) {
    return
  }
  event.preventDefault()
  callback(credentials.username, credentials.password)
}
