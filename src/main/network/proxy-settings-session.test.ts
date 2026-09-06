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
  applyProxySettingsToSession,
  awaitProxySessionApplication,
  releaseProxySessionApplication,
  retireProxySessionApplication,
  resetSessionProxyApplicationForTests
} from './proxy-settings'
import { handleElectronProxyLogin } from './electron-proxy-credentials'

function createProxySession() {
  return {
    resolveProxy: vi.fn(async () => 'DIRECT'),
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

describe('applyProxySettingsToSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pins the configured proxy onto a non-default session', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        {
          httpProxyUrl: ' socks5://127.0.0.1:1080/ ',
          httpProxyBypassRules: 'localhost, *.internal'
        },
        { env: {} }
      )
    ).resolves.toEqual({
      source: 'settings',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('does not touch defaultSession when applying to another session', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env: {} }
    )

    expect(defaultSessionMock.setProxy).not.toHaveBeenCalled()
  })

  it('tracks applied config per session, so one session does not suppress another', async () => {
    const first = createProxySession()
    const second = createProxySession()
    resetSessionProxyApplicationForTests(first)
    resetSessionProxyApplicationForTests(second)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    await applyProxySettingsToSession(first, settings, { env: {} })
    await applyProxySettingsToSession(second, settings, { env: {} })

    expect(first.setProxy).toHaveBeenCalledTimes(1)
    expect(second.setProxy).toHaveBeenCalledTimes(1)
  })

  it('skips a redundant write when the same config is re-applied', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    await applyProxySettingsToSession(proxySession, settings, { env: {} })
    await applyProxySettingsToSession(proxySession, settings, { env: {} })

    expect(proxySession.setProxy).toHaveBeenCalledTimes(1)
  })

  it('refreshes in-memory authentication when only proxy credentials change', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://alice:old-secret@proxy.example:8080' },
      { env: {} }
    )
    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://alice:new-secret@proxy.example:8080' },
      { env: {} }
    )

    expect(proxySession.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080' }]
    ])
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
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
    expect(callback).toHaveBeenCalledWith('alice', 'new-secret')
  })

  it('coalesces concurrent writes of the same config', async () => {
    let finishWrite: (() => void) | undefined
    const proxySession = createProxySession()
    proxySession.setProxy.mockImplementation(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    )
    resetSessionProxyApplicationForTests(proxySession)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    const first = applyProxySettingsToSession(proxySession, settings, { env: {} })
    const second = applyProxySettingsToSession(proxySession, settings, { env: {} })

    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(1))
    finishWrite?.()
    await Promise.all([first, second])
    expect(proxySession.setProxy).toHaveBeenCalledTimes(1)
  })

  it('serializes config changes so an older write cannot finish last', async () => {
    let finishFirstWrite: (() => void) | undefined
    let effectiveProxy: string | undefined
    const proxySession = createProxySession()
    proxySession.setProxy
      .mockImplementationOnce(
        (config) =>
          new Promise<void>((resolve) => {
            finishFirstWrite = () => {
              effectiveProxy = config.proxyRules
              resolve()
            }
          })
      )
      .mockImplementationOnce(async (config) => {
        effectiveProxy = config.proxyRules
      })
    resetSessionProxyApplicationForTests(proxySession)

    const first = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://old.example:8080', httpProxyBypassRules: '' },
      { env: {} }
    )
    const second = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://new.example:8080', httpProxyBypassRules: '' },
      { env: {} }
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

  it('holds request readiness until the newest queued policy settles', async () => {
    let finishFirstWrite: (() => void) | undefined
    let finishSecondWrite: (() => void) | undefined
    const proxySession = createProxySession()
    proxySession.setProxy
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirstWrite = resolve)))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishSecondWrite = resolve)))
    resetSessionProxyApplicationForTests(proxySession)

    const first = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://old.example:8080' },
      { env: {} }
    )
    const second = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://new.example:8080' },
      { env: {} }
    )
    let requestReleased = false
    const readiness = awaitProxySessionApplication(proxySession).then((ready) => {
      requestReleased = true
      return ready
    })

    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(1))
    expect(requestReleased).toBe(false)
    finishFirstWrite?.()
    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(2))
    expect(requestReleased).toBe(false)
    finishSecondWrite?.()

    await expect(readiness).resolves.toBe(true)
    await Promise.all([first, second])
  })

  it('keeps request readiness closed after proxy application fails', async () => {
    const proxySession = createProxySession()
    proxySession.setProxy.mockRejectedValue(new Error('proxy apply failed'))
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://proxy.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('proxy apply failed')

    await expect(awaitProxySessionApplication(proxySession)).resolves.toBe(false)
  })

  it('keeps a deleted partition retired while its proxy release settles', async () => {
    let finishClose: (() => void) | undefined
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://proxy.example:8080' },
      { env: {} }
    )
    proxySession.closeAllConnections.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishClose = resolve))
    )

    const retirement = retireProxySessionApplication(proxySession)
    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledWith({ mode: 'system' }))
    await expect(awaitProxySessionApplication(proxySession)).resolves.toBe(false)
    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://later.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('retired')

    finishClose?.()
    await retirement
    await expect(awaitProxySessionApplication(proxySession)).resolves.toBe(false)
  })

  it('forgets credentials when a retired partition cannot release its proxy', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://alice:secret@proxy.example:8080' },
      { env: {} }
    )
    proxySession.setProxy.mockRejectedValue(new Error('proxy release failed'))

    await expect(retireProxySessionApplication(proxySession)).rejects.toThrow(
      'proxy release failed'
    )
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
      { session: proxySession } as never,
      {} as never,
      { isProxy: true, host: 'proxy.example', port: 8080 },
      callback
    )

    expect(callback).not.toHaveBeenCalled()
  })

  it('orders a slow environment probe before a newer explicit setting', async () => {
    let finishProbe: ((result: string) => void) | undefined
    const proxySession = createProxySession()
    proxySession.resolveProxy.mockImplementation(
      () => new Promise<string>((resolve) => (finishProbe = resolve))
    )
    resetSessionProxyApplicationForTests(proxySession)

    const environment = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: '', httpProxyBypassRules: '' },
      { env: { HTTP_PROXY: 'http://env.example:8080' } }
    )
    const explicit = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://configured.example:8080', httpProxyBypassRules: '' },
      { env: {} }
    )

    await vi.waitFor(() => expect(proxySession.resolveProxy).toHaveBeenCalledTimes(1))
    expect(proxySession.setProxy).not.toHaveBeenCalled()
    finishProbe?.('DIRECT')
    await Promise.all([environment, explicit])

    expect(proxySession.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://env.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://configured.example:8080' }]
    ])
  })

  it('falls back to the environment proxy when no proxy is configured', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: { HTTPS_PROXY: 'http://env.example:8080', NO_PROXY: 'localhost' } }
      )
    ).resolves.toEqual({
      source: 'env',
      proxyRules: 'http://env.example:8080',
      proxyBypassRules: 'localhost'
    })
    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://env.example:8080',
      proxyBypassRules: 'localhost'
    })
  })

  it('releases a pin before probing for a system proxy', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    const env = { HTTPS_PROXY: 'http://env.example:8080' }

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env }
    )
    proxySession.setProxy.mockClear()
    proxySession.resolveProxy.mockResolvedValue('PROXY system.example:8080')

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env }
      )
    ).resolves.toEqual({ source: 'system' })

    expect(proxySession.setProxy).toHaveBeenCalledOnce()
    expect(proxySession.setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('re-applies a pin after its release drops connections unsuccessfully', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    await applyProxySettingsToSession(proxySession, settings, { env: {} })
    proxySession.closeAllConnections
      .mockRejectedValueOnce(new Error('close failed'))
      .mockRejectedValueOnce(new Error('close failed'))
      .mockRejectedValueOnce(new Error('close failed'))
    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: {} }
      )
    ).rejects.toThrow('close failed')

    proxySession.setProxy.mockClear()
    await applyProxySettingsToSession(proxySession, settings, { env: {} })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080'
    })
  })

  it('retries stale connection cleanup before a cleared proxy becomes ready', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env: {} }
    )
    proxySession.closeAllConnections.mockRejectedValueOnce(new Error('close failed'))

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: {} }
      )
    ).resolves.toEqual({ source: 'none' })

    expect(proxySession.setProxy.mock.calls.slice(-2)).toEqual([
      [{ mode: 'system' }],
      [{ mode: 'system' }]
    ])
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(3)
    await expect(awaitProxySessionApplication(proxySession)).resolves.toBe(true)
  })

  it('fails closed after all bounded proxy application attempts reject', async () => {
    const proxySession = createProxySession()
    proxySession.setProxy.mockRejectedValue(new Error('proxy apply failed'))
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://proxy.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('proxy apply failed')

    expect(proxySession.setProxy).toHaveBeenCalledTimes(3)
    await expect(awaitProxySessionApplication(proxySession)).resolves.toBe(false)
  })

  it('releases a previously pinned session back to the system proxy when settings are cleared', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env: {} }
    )
    proxySession.setProxy.mockClear()

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: {} }
      )
    ).resolves.toEqual({ source: 'none' })
    expect(proxySession.setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('forgets authentication when a session returns to the system proxy', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://alice:secret@proxy.example:8080' },
      { env: {} }
    )
    await applyProxySettingsToSession(proxySession, { httpProxyUrl: '' }, { env: {} })

    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
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
    expect(callback).not.toHaveBeenCalled()
  })

  it('releases a removed session through the ordered proxy queue', async () => {
    let finishWrite: (() => void) | undefined
    const proxySession = createProxySession()
    proxySession.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    )
    resetSessionProxyApplicationForTests(proxySession)

    const applying = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://alice:secret@proxy.example:8080' },
      { env: {} }
    )
    const releasing = releaseProxySessionApplication(proxySession)
    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(1))
    finishWrite?.()
    await Promise.all([applying, releasing])

    expect(proxySession.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080' }],
      [{ mode: 'system' }]
    ])
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
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
    expect(callback).not.toHaveBeenCalled()
  })

  it('leaves an untouched session alone when nothing is configured', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: '', httpProxyBypassRules: '' },
      { env: {} }
    )

    expect(proxySession.setProxy).not.toHaveBeenCalled()
  })
})
