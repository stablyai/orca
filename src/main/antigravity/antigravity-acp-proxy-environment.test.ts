// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const readSystemProxyMock = vi.hoisted(() => vi.fn())
vi.mock('../network/macos-python-proxy-environment', () => ({
  readMacosPythonProxyEnvironment: readSystemProxyMock
}))

import { prepareAntigravityAcpProxyEnvironment } from './antigravity-acp-proxy-environment'

// The managed Antigravity harness talks to its private WebSocket over loopback; no system proxy
// policy may route that traffic, even when the policy itself cannot be mirrored (#44498).
describe('prepareAntigravityAcpProxyEnvironment', () => {
  it('keeps loopback direct when the system policy cannot be represented', async () => {
    readSystemProxyMock.mockResolvedValue({ kind: 'unrepresentable' })
    const env: Record<string, string> = { PATH: '/usr/bin' }
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1,[::1]')
    // Nothing else is imported: external requests keep following the system policy.
    expect(env.http_proxy).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
  })

  it('appends loopback to an inherited bypass list', async () => {
    readSystemProxyMock.mockResolvedValue({ kind: 'unrepresentable' })
    const env: Record<string, string> = {}
    await prepareAntigravityAcpProxyEnvironment(env, { NO_PROXY: 'corp.internal' })
    expect(env.NO_PROXY).toBe('corp.internal,localhost,127.0.0.1,::1,[::1]')
    expect(env.no_proxy).toBe('corp.internal,localhost,127.0.0.1,::1,[::1]')
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
    expect(env.NO_PROXY).toBe('.local,localhost,127.0.0.1,::1,[::1]')
  })
})
