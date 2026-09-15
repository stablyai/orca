import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent } from 'undici'
import { setElectronProxyCredentialsForSession } from './electron-proxy-credentials'
import { setDefaultProxySessionResolver, type ProxySession } from './electron-default-proxy-session'
import {
  outboundProxyFetchDispatcher,
  outboundProxySocketAgent,
  resolveOutboundProxyUrl
} from './outbound-proxy'

function createProxySession(
  resolved: string
): ProxySession & { resolveProxy: ReturnType<typeof vi.fn> } {
  return {
    resolveProxy: vi.fn(async () => resolved),
    setProxy: vi.fn(async () => {})
  }
}

function agentProxyUrl(agent: Awaited<ReturnType<typeof outboundProxySocketAgent>>): string | null {
  // The agent stores a URL, whose normalization appends the empty path.
  return agent && 'proxy' in agent ? String(agent.proxy).replace(/\/$/, '') : null
}

describe('main-process outbound proxy', () => {
  afterEach(() => {
    setDefaultProxySessionResolver(null)
    vi.unstubAllEnvs()
  })

  it('tunnels a proxied target through the Chromium-resolved proxy', async () => {
    const proxySession = createProxySession('PROXY 127.0.0.1:3128')
    setDefaultProxySessionResolver(() => proxySession)

    const agent = await outboundProxySocketAgent('wss://relay.example/v1/host/control')

    expect(agent).toBeInstanceOf(HttpsProxyAgent)
    expect(agentProxyUrl(agent)).toBe('http://127.0.0.1:3128')
    // Chromium resolves proxies for the http sibling of a ws target.
    expect(proxySession.resolveProxy).toHaveBeenCalledWith('https://relay.example/v1/host/control')
  })

  it('gives the Node fetch fallback a dispatcher for the same target', async () => {
    setDefaultProxySessionResolver(() => createProxySession('PROXY 127.0.0.1:3128'))

    expect(
      await outboundProxyFetchDispatcher('https://login.onorca.dev/v1/desktop/auth/session')
    ).toBeInstanceOf(ProxyAgent)
  })

  it('leaves a bypassed or direct target on the direct path', async () => {
    const proxySession = createProxySession('DIRECT')
    setDefaultProxySessionResolver(() => proxySession)

    expect(
      await resolveOutboundProxyUrl('https://login.onorca.dev/v1/desktop/auth/session')
    ).toBeNull()
    expect(await outboundProxySocketAgent('wss://relay.example/v1/host/control')).toBeUndefined()
    expect(await outboundProxyFetchDispatcher('https://relay.example/v1/assign')).toBeUndefined()
    expect(proxySession.resolveProxy).toHaveBeenCalledTimes(3)
  })

  it('never proxies loopback, matching Chromium own bypass', async () => {
    const proxySession = createProxySession('PROXY 127.0.0.1:3128')
    setDefaultProxySessionResolver(() => proxySession)

    expect(await outboundProxySocketAgent('ws://127.0.0.1:4100/v1/host/control')).toBeUndefined()
    expect(proxySession.resolveProxy).not.toHaveBeenCalled()
  })

  it('leaves a proxy rule it cannot tunnel on the direct path', async () => {
    setDefaultProxySessionResolver(() => createProxySession('SOCKS5 127.0.0.1:1080'))

    expect(await resolveOutboundProxyUrl('https://relay.example/v1/assign')).toBeNull()
  })

  it('leaves an unusable proxy rule on the direct path', async () => {
    setDefaultProxySessionResolver(() => createProxySession('PROXY not a host:port:extra'))

    expect(await resolveOutboundProxyUrl('https://relay.example/v1/assign')).toBeNull()
  })

  it('attaches the credentials the same settings produced', async () => {
    const proxySession = createProxySession('PROXY proxy.corp.example:8080')
    setDefaultProxySessionResolver(() => proxySession)
    setElectronProxyCredentialsForSession(proxySession, {
      host: 'proxy.corp.example',
      port: 8080,
      username: 'nina',
      password: 'p@ss word'
    })

    const agent = await outboundProxySocketAgent('wss://relay.example/v1/host/control')

    expect(agentProxyUrl(agent)).toBe('http://nina:p%40ss%20word@proxy.corp.example:8080')
  })

  it('falls back to the proxy environment, credentials included, on a host without a Chromium session', async () => {
    setDefaultProxySessionResolver(null)
    vi.stubEnv('HTTPS_PROXY', 'http://nina:s3cret@proxy.env.example:3128')

    expect(await resolveOutboundProxyUrl('https://login.onorca.dev/v1/desktop/auth/session')).toBe(
      'http://nina:s3cret@proxy.env.example:3128'
    )
    // A credential-less URL would make an authenticated proxy answer 407.
    expect(
      agentProxyUrl(await outboundProxySocketAgent('wss://relay.example/v1/host/control'))
    ).toBe('http://nina:s3cret@proxy.env.example:3128')
  })

  it('honours the environment bypass list on the host without a Chromium session', async () => {
    setDefaultProxySessionResolver(null)
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.env.example:3128')

    vi.stubEnv('NO_PROXY', 'onorca.dev, .internal.example')
    expect(
      await resolveOutboundProxyUrl('https://login.onorca.dev/v1/desktop/auth/session')
    ).toBeNull()
    expect(await resolveOutboundProxyUrl('https://relay.internal.example/v1/assign')).toBeNull()

    vi.stubEnv('NO_PROXY', 'other.example')
    expect(await resolveOutboundProxyUrl('https://login.onorca.dev/v1/desktop/auth/session')).toBe(
      'http://proxy.env.example:3128'
    )

    vi.stubEnv('NO_PROXY', '*')
    expect(await resolveOutboundProxyUrl('https://relay.example/v1/assign')).toBeNull()

    // A bypass entry that names another port does not cover this target.
    vi.stubEnv('NO_PROXY', 'relay.example:8080')
    expect(await resolveOutboundProxyUrl('https://relay.example/v1/assign')).toBe(
      'http://proxy.env.example:3128'
    )
  })
})
