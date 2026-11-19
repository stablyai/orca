// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const readSystemProxyMock = vi.hoisted(() => vi.fn())
vi.mock('../network/macos-python-proxy-environment', () => ({
  readMacosPythonProxyEnvironment: readSystemProxyMock
}))

import { prepareAntigravityAcpProxyEnvironment } from './antigravity-acp-proxy-environment'

describe('prepareAntigravityAcpProxyEnvironment', () => {
  it('imports lossy system proxies alongside widened exclusions and loopback bypass', async () => {
    readSystemProxyMock.mockResolvedValue({
      kind: 'environment',
      proxies: { socks: 'http://127.0.0.1:7890' },
      bypass: ['.local', '.example.test'],
      lossy: true
    })
    const env: Record<string, string> = { PATH: '/usr/bin' }
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env).toEqual({
      PATH: '/usr/bin',
      socks_proxy: 'http://127.0.0.1:7890',
      SOCKS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '.local,.example.test,localhost,127.0.0.1,::1,[::1]',
      no_proxy: '.local,.example.test,localhost,127.0.0.1,::1,[::1]'
    })
  })

  it('sets loopback-only NO_PROXY for PAC-only configurations without importing proxy vars', async () => {
    readSystemProxyMock.mockResolvedValue({ kind: 'unrepresentable' })
    const env: Record<string, string> = { PATH: '/usr/bin' }
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1,[::1]')
    expect(env.http_proxy).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
  })

  it('appends loopback to an inherited bypass list when an environment proxy is present', async () => {
    const env: Record<string, string> = { http_proxy: 'http://127.0.0.1:7890' }
    await prepareAntigravityAcpProxyEnvironment(env, { NO_PROXY: 'corp.internal' })
    expect(env.NO_PROXY).toBe('corp.internal,localhost,127.0.0.1,::1,[::1]')
    expect(env.no_proxy).toBe('corp.internal,localhost,127.0.0.1,::1,[::1]')
  })

  it('leaves a no_proxy-only environment without proxy vars untouched', async () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }
    await prepareAntigravityAcpProxyEnvironment(env, { NO_PROXY: 'corp.internal' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('leaves the environment untouched when no proxy is configured', async () => {
    readSystemProxyMock.mockResolvedValue(null)
    const env: Record<string, string> = { PATH: '/usr/bin' }
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('imports a representable system policy and still adds loopback', async () => {
    readSystemProxyMock.mockResolvedValue({
      kind: 'environment',
      proxies: { http: 'http://proxy.example:3128' },
      bypass: ['.local']
    })
    const env: Record<string, string> = {}
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env.http_proxy).toBe('http://proxy.example:3128')
    expect(env.HTTP_PROXY).toBe('http://proxy.example:3128')
    expect(env.NO_PROXY).toBe('.local,localhost,127.0.0.1,::1,[::1]')
  })
})
