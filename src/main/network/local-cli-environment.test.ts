import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { hydrateShellPathMock, mergePersistedWindowsPathMock } = vi.hoisted(() => ({
  hydrateShellPathMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: hydrateShellPathMock
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPath: mergePersistedWindowsPathMock
}))

import {
  _resetLocalCliProxySettings,
  buildLocalCliEnvironment,
  setLocalCliProxySettings
} from './local-cli-environment'

describe('local CLI environment', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    _resetLocalCliProxySettings()
    hydrateShellPathMock.mockReset()
    mergePersistedWindowsPathMock.mockReset()
    hydrateShellPathMock.mockResolvedValue({
      segments: ['/usr/local/bin'],
      proxyEnv: {
        HTTPS_PROXY: 'http://shell-proxy.example:8080',
        https_proxy: 'http://shell-lower.example:8080',
        NO_PROXY: 'localhost'
      },
      ok: true,
      failureReason: 'none'
    })
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('fills missing proxy variables from the login shell without importing unrelated values', async () => {
    const env = await buildLocalCliEnvironment({
      PATH: '/usr/bin',
      GH_TOKEN: 'token-from-launch'
    })

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      GH_TOKEN: 'token-from-launch',
      HTTPS_PROXY: 'http://shell-proxy.example:8080',
      https_proxy: 'http://shell-lower.example:8080',
      NO_PROXY: 'localhost'
    })
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  it('preserves launch-time proxy variables when Orca has no manual proxy', async () => {
    const env = await buildLocalCliEnvironment({
      HTTPS_PROXY: 'http://launch-proxy.example:8080',
      NO_PROXY: 'launch.internal'
    })

    expect(env.HTTPS_PROXY).toBe('http://launch-proxy.example:8080')
    expect(env.NO_PROXY).toBe('launch.internal')
  })

  it('lets manual Orca proxy settings override inherited proxy and bypass values', async () => {
    setLocalCliProxySettings({
      httpProxyUrl: 'http://orca-proxy.example:9000',
      httpProxyBypassRules: 'localhost;*.internal'
    })

    const env = await buildLocalCliEnvironment({
      HTTPS_PROXY: 'http://launch-proxy.example:8080',
      NO_PROXY: 'launch.internal'
    })

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://orca-proxy.example:9000',
      HTTPS_PROXY: 'http://orca-proxy.example:9000',
      ALL_PROXY: 'http://orca-proxy.example:9000',
      http_proxy: 'http://orca-proxy.example:9000',
      https_proxy: 'http://orca-proxy.example:9000',
      all_proxy: 'http://orca-proxy.example:9000',
      NO_PROXY: 'localhost,*.internal',
      no_proxy: 'localhost,*.internal'
    })
  })

  it('uses persisted Windows Path without importing the host shell proxy snapshot', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    mergePersistedWindowsPathMock.mockImplementation((env: Record<string, string>) => {
      env.Path = 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI'
    })

    const env = await buildLocalCliEnvironment({ Path: 'C:\\Windows\\System32' })

    expect(env.Path).toContain('GitHub CLI')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(hydrateShellPathMock).not.toHaveBeenCalled()
  })
})
