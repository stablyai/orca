import { beforeEach, describe, expect, it, vi } from 'vitest'

const { defaultSessionMock } = vi.hoisted(() => ({
  defaultSessionMock: {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {})
  }
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: defaultSessionMock
  }
}))

import {
  applyElectronProxySettings,
  ensureElectronProxyFromEnvironment,
  resetProxyApplicationForTests
} from './proxy-settings'

function createProxySession(resolveProxy = 'DIRECT') {
  return {
    resolveProxy: vi.fn(async () => resolveProxy),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {})
  }
}

describe('Electron proxy settings', () => {
  beforeEach(() => {
    resetProxyApplicationForTests()
  })

  it('applies explicit settings before env fallback', async () => {
    const proxySession = createProxySession()

    await expect(
      applyElectronProxySettings(
        {
          httpProxyUrl: ' http://user:pass@proxy.example:8080/path#token ',
          httpProxyBypassRules: 'localhost, *.internal'
        },
        {
          proxySession,
          env: { HTTPS_PROXY: 'http://env.example:8080' }
        }
      )
    ).resolves.toEqual({
      source: 'settings',
      proxyRules: 'http://user:pass@proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://user:pass@proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })
    expect(proxySession.resolveProxy).not.toHaveBeenCalled()
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('preserves system proxy settings when no explicit or env proxy is configured', async () => {
    const proxySession = createProxySession('PROXY system.example:8080')

    await expect(applyElectronProxySettings({}, { proxySession, env: {} })).resolves.toEqual({
      source: 'system'
    })

    expect(proxySession.setProxy).not.toHaveBeenCalled()
  })

  it('bridges env proxy vars only when Chromium would otherwise go direct', async () => {
    const proxySession = createProxySession('DIRECT')

    await expect(
      applyElectronProxySettings(
        {},
        {
          proxySession,
          env: {
            HTTPS_PROXY: 'https://env.example:8443',
            HTTP_PROXY: 'http://lower-priority.example:8080',
            NO_PROXY: 'localhost,*.internal'
          }
        }
      )
    ).resolves.toEqual({
      source: 'env',
      proxyRules: 'https://env.example:8443',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'https://env.example:8443',
      proxyBypassRules: 'localhost;*.internal'
    })
  })

  it('clears a previous app proxy before returning to system/env behavior', async () => {
    const proxySession = createProxySession('DIRECT')

    await applyElectronProxySettings(
      { httpProxyUrl: 'http://proxy.example:8080' },
      { proxySession }
    )
    await applyElectronProxySettings(
      { httpProxyUrl: '' },
      { proxySession, env: { HTTP_PROXY: 'http://env.example:8080' } }
    )

    expect(proxySession.setProxy).toHaveBeenNthCalledWith(2, { mode: 'system' })
    expect(proxySession.setProxy).toHaveBeenNthCalledWith(3, {
      mode: 'fixed_servers',
      proxyRules: 'http://env.example:8080'
    })
  })

  it('does not let env fallback override an already-applied explicit setting', async () => {
    const proxySession = createProxySession('DIRECT')

    await applyElectronProxySettings(
      { httpProxyUrl: 'http://proxy.example:8080' },
      { proxySession }
    )
    await ensureElectronProxyFromEnvironment({
      proxySession,
      env: { HTTP_PROXY: 'http://env.example:8080' }
    })

    expect(proxySession.setProxy).toHaveBeenCalledTimes(1)
  })
})
