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
  resetProxyApplicationForTests,
  setDefaultProxySessionResolver
} from './proxy-settings'
import { handleElectronProxyLogin } from './electron-proxy-credentials'

function createProxySession(resolveProxy = 'DIRECT') {
  return {
    resolveProxy: vi.fn(async () => resolveProxy),
    setProxy: vi.fn(
      async (_config: {
        mode?: 'system' | 'fixed_servers'
        proxyRules?: string
        proxyBypassRules?: string
      }) => {}
    ),
    closeAllConnections: vi.fn(async () => {})
  }
}

describe('Electron proxy settings', () => {
  beforeEach(() => {
    resetProxyApplicationForTests()
    setDefaultProxySessionResolver(() => defaultSessionMock)
  })

  it('resolves proxy policy without a Chromium session on Node hosts', async () => {
    setDefaultProxySessionResolver(null)

    await expect(
      applyElectronProxySettings(
        {
          httpProxyUrl: 'http://user:pass@proxy.example:8080',
          httpProxyBypassRules: 'localhost,*.internal'
        },
        { env: { HTTP_PROXY: 'http://env.example:8080' } }
      )
    ).resolves.toEqual({
      source: 'settings',
      proxyRules: 'http://proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })
    await expect(
      applyElectronProxySettings({}, { env: { HTTP_PROXY: 'http://env.example:8080' } })
    ).resolves.toEqual({ source: 'env', proxyRules: 'http://env.example:8080' })
    expect(defaultSessionMock.setProxy).not.toHaveBeenCalled()
  })

  it('applies explicit settings before env fallback', async () => {
    const proxySession = createProxySession('PROXY system.example:8080')

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
      proxyRules: 'http://proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })
    expect(proxySession.resolveProxy).not.toHaveBeenCalled()
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('serializes default-session transitions so the newest setting wins', async () => {
    let finishFirstWrite: (() => void) | undefined
    let effectiveProxy = ''
    const proxySession = createProxySession()
    proxySession.setProxy
      .mockImplementationOnce(
        (config) =>
          new Promise<void>((resolve) => {
            finishFirstWrite = () => {
              effectiveProxy = config.proxyRules ?? ''
              resolve()
            }
          })
      )
      .mockImplementationOnce(async (config) => {
        effectiveProxy = config.proxyRules ?? ''
      })

    const first = applyElectronProxySettings(
      { httpProxyUrl: 'http://old.example:8080' },
      { proxySession, env: {} }
    )
    const second = applyElectronProxySettings(
      { httpProxyUrl: 'http://new.example:8080' },
      { proxySession, env: {} }
    )

    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(1))
    finishFirstWrite?.()
    await Promise.all([first, second])

    expect(proxySession.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://new.example:8080' }]
    ])
    expect(effectiveProxy).toBe('http://new.example:8080')
  })

  it('keeps credentials out of proxy metadata and answers matching proxy auth challenges', async () => {
    const proxySession = createProxySession()
    const result = await applyElectronProxySettings(
      { httpProxyUrl: 'http://alice:s%40fe@proxy.example:8080' },
      { proxySession, env: {} }
    )

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080'
    })
    expect(JSON.stringify(result)).not.toContain('alice')
    expect(JSON.stringify(result)).not.toContain('s%40fe')
    expect(JSON.stringify(result)).not.toContain('s@fe')

    const preventDefault = vi.fn()
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault } as never,
      { session: proxySession } as never,
      {} as never,
      {
        isProxy: true,
        scheme: 'basic',
        host: 'proxy.example',
        port: 8080,
        realm: 'proxy'
      },
      callback
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('alice', 's@fe')
  })

  it('answers proxy auth for app requests without an associated webContents', async () => {
    await applyElectronProxySettings({
      httpProxyUrl: 'http://app-user:app-pass@proxy.example:8080'
    })
    const preventDefault = vi.fn()
    const callback = vi.fn()

    handleElectronProxyLogin(
      { preventDefault } as never,
      null,
      {} as never,
      {
        isProxy: true,
        scheme: 'basic',
        host: 'proxy.example',
        port: 8080,
        realm: 'proxy'
      },
      callback,
      defaultSessionMock
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('app-user', 'app-pass')
  })

  it('does not disclose proxy credentials to origin or mismatched proxy challenges', async () => {
    const proxySession = createProxySession()
    await applyElectronProxySettings(
      { httpProxyUrl: 'http://alice:secret@proxy.example:8080' },
      { proxySession, env: {} }
    )
    const preventDefault = vi.fn()
    const callback = vi.fn()

    for (const authInfo of [
      { isProxy: false, host: 'proxy.example', port: 8080 },
      { isProxy: true, host: 'other.example', port: 8080 },
      { isProxy: true, host: 'proxy.example', port: 3128 }
    ]) {
      handleElectronProxyLogin(
        { preventDefault } as never,
        { session: proxySession } as never,
        {} as never,
        { scheme: 'basic', realm: 'proxy', ...authInfo },
        callback
      )
    }

    expect(preventDefault).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('preserves system proxy settings when no explicit or env proxy is configured', async () => {
    const proxySession = createProxySession('PROXY system.example:8080')

    await expect(applyElectronProxySettings({}, { proxySession, env: {} })).resolves.toEqual({
      source: 'system'
    })

    expect(proxySession.setProxy).not.toHaveBeenCalled()
  })

  it('preserves the system proxy ahead of environment fallback', async () => {
    const proxySession = createProxySession('PROXY system.example:8080')

    await expect(
      applyElectronProxySettings(
        {},
        { proxySession, env: { HTTP_PROXY: 'http://env.example:8080' } }
      )
    ).resolves.toEqual({ source: 'system' })

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

  it('retries a transient connection-close failure before reporting an explicit proxy', async () => {
    const proxySession = createProxySession()
    proxySession.closeAllConnections.mockRejectedValueOnce(new Error('close failed'))

    await expect(
      applyElectronProxySettings(
        { httpProxyUrl: 'http://proxy.example:8080' },
        { proxySession, env: {} }
      )
    ).resolves.toEqual({ source: 'settings', proxyRules: 'http://proxy.example:8080' })
    await expect(
      ensureElectronProxyFromEnvironment({
        proxySession,
        env: { HTTP_PROXY: 'http://env.example:8080' }
      })
    ).resolves.toEqual({
      source: 'settings',
      proxyRules: 'http://proxy.example:8080'
    })

    expect(proxySession.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080' }]
    ])
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(2)
  })
})
