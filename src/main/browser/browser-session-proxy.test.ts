import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionsByPartition, fromPartition, fromPartitionMock } = vi.hoisted(() => {
  const createSession = () => ({
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {})
  })
  const sessionsByPartition = new Map<string, ReturnType<typeof createSession>>()
  const fromPartition = (partition: string): ReturnType<typeof createSession> => {
    const existing = sessionsByPartition.get(partition)
    if (existing) {
      return existing
    }
    const created = createSession()
    sessionsByPartition.set(partition, created)
    return created
  }
  return { sessionsByPartition, fromPartition, fromPartitionMock: vi.fn(fromPartition) }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT'), setProxy: vi.fn(async () => {}) },
    fromPartition: fromPartitionMock
  }
}))

import {
  applyBrowserSessionProxies,
  awaitBrowserSessionProxies,
  applyProxyToBrowserSession,
  invalidateBrowserSessionProxyApplication,
  setBrowserNetworkProxySettingsResolver
} from './browser-session-proxy'
import { handleElectronProxyLogin } from '../network/electron-proxy-credentials'
import {
  applyProxySettingsToSession,
  releaseProxySessionApplication
} from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network-proxy'

const PROFILES = [
  {
    id: 'default',
    scope: 'default' as const,
    partition: 'persist:orca-browser',
    label: 'Default',
    source: null
  },
  {
    id: 'iso',
    scope: 'isolated' as const,
    partition: 'persist:orca-browser-session-iso',
    label: 'Isolated',
    source: null
  }
]

describe('browser session proxy', () => {
  beforeEach(() => {
    sessionsByPartition.clear()
    fromPartitionMock.mockReset().mockImplementation(fromPartition)
    setBrowserNetworkProxySettingsResolver(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pins the configured proxy onto every browser partition', async () => {
    await applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })

    expect(fromPartitionMock).toHaveBeenCalledWith('persist:orca-browser')
    expect(fromPartitionMock).toHaveBeenCalledWith('persist:orca-browser-session-iso')
    for (const partition of PROFILES.map((p) => p.partition)) {
      expect(sessionsByPartition.get(partition)?.setProxy).toHaveBeenCalledWith({
        mode: 'fixed_servers',
        proxyRules: 'socks5://127.0.0.1:1080'
      })
    }
  })

  it('carries bypass rules through to each partition', async () => {
    await applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: 'localhost, *.internal'
    })

    expect(sessionsByPartition.get('persist:orca-browser')?.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })
  })

  it('authenticates a credentialed proxy without exposing credentials in partition rules', async () => {
    await applyBrowserSessionProxies(PROFILES.slice(0, 1), {
      httpProxyUrl: 'http://browser-user:browser-pass@proxy.example:8080',
      httpProxyBypassRules: ''
    })
    const sess = sessionsByPartition.get('persist:orca-browser')
    expect(sess?.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080'
    })

    const preventDefault = vi.fn()
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault } as never,
      { session: sess } as never,
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
    expect(callback).toHaveBeenCalledWith('browser-user', 'browser-pass')
  })

  it('keeps sweeping but reports failure so the failed partition stays gated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fromPartitionMock.mockImplementationOnce(() => {
      throw new Error('partition unavailable')
    })

    await expect(
      applyBrowserSessionProxies(PROFILES, {
        httpProxyUrl: 'socks5://127.0.0.1:1080',
        httpProxyBypassRules: ''
      })
    ).rejects.toThrow('persist:orca-browser')

    expect(
      sessionsByPartition.get('persist:orca-browser-session-iso')?.setProxy
    ).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080' })
    expect(warn).toHaveBeenCalledWith(
      '[proxy] Failed to apply proxy to browser partition',
      'persist:orca-browser'
    )
  })

  it('starts every partition write without waiting for earlier partitions', async () => {
    let finishFirstWrite: (() => void) | undefined
    const firstSession = fromPartition('persist:orca-browser')
    firstSession.setProxy.mockImplementation(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    )
    sessionsByPartition.set('persist:orca-browser', firstSession)

    const sweep = applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })

    await vi.waitFor(() =>
      expect(
        sessionsByPartition.get('persist:orca-browser-session-iso')?.setProxy
      ).toHaveBeenCalledOnce()
    )
    finishFirstWrite?.()
    await sweep
  })

  it('settles an in-flight new partition on the latest swept policy', async () => {
    let proxyUrl = 'http://old.example:8080'
    let finishFirstWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const sess = fromPartition('persist:orca-browser-session-pending')
    sess.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    )

    const pendingInstallation = applyProxyToBrowserSession(sess as never)
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    proxyUrl = 'http://new.example:8080'
    await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
    finishFirstWrite?.()
    await pendingInstallation

    expect(sess.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://new.example:8080' }]
    ])
  })

  it('does not reapply policy after an in-flight partition is invalidated', async () => {
    let proxyUrl = 'http://old.example:8080'
    let finishFirstWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const sess = fromPartition('persist:orca-browser-session-restored')
    sess.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    )

    const restoredInstallation = applyProxyToBrowserSession(sess as never)
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    invalidateBrowserSessionProxyApplication(sess as never)
    const release = releaseProxySessionApplication(sess as never)
    proxyUrl = 'http://new.example:8080'
    await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
    finishFirstWrite?.()
    await Promise.all([restoredInstallation, release])

    expect(sess.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }],
      [{ mode: 'system' }]
    ])
  })

  it('reads settings through the injected resolver when none are passed', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))
    const sess = fromPartitionMock('persist:orca-browser')

    await applyProxyToBrowserSession(sess as never)

    expect(sess.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080'
    })
  })

  it('makes no proxy write when no resolver is registered', async () => {
    const sess = fromPartitionMock('persist:orca-browser')

    await applyProxyToBrowserSession(sess as never)

    expect(sess.setProxy).not.toHaveBeenCalled()
  })

  describe('startup readiness', () => {
    beforeEach(() => {
      for (const key of [
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY'
      ]) {
        vi.stubEnv(key, '')
      }
      setBrowserNetworkProxySettingsResolver(() => ({}))
    })

    afterEach(() => vi.unstubAllEnvs())

    it('awaits installed policies without reapplying them and keeps later system probes fresh', async () => {
      const sessions = PROFILES.map((profile) => fromPartition(profile.partition))
      const finishResolutions: (() => void)[] = []
      for (const sess of sessions) {
        sess.resolveProxy.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finishResolutions.push(() => resolve('DIRECT'))
            })
        )
      }
      const installations = sessions.map((sess) => applyProxySettingsToSession(sess, {}))
      let settled = false
      const startup = awaitBrowserSessionProxies(PROFILES).then(() => (settled = true))

      await vi.waitFor(() => expect(finishResolutions).toHaveLength(PROFILES.length))
      expect(settled).toBe(false)
      for (const finish of finishResolutions) {
        finish()
      }
      await Promise.all([...installations, startup])
      await awaitBrowserSessionProxies(PROFILES)

      for (const sess of sessions) {
        expect(sess.resolveProxy).toHaveBeenCalledOnce()
        expect(sess.setProxy).not.toHaveBeenCalled()
        sess.resolveProxy.mockResolvedValue('PROXY changed-system.example:8080')
      }
      await applyBrowserSessionProxies(PROFILES, {})
      for (const sess of sessions) {
        expect(sess.resolveProxy).toHaveBeenCalledTimes(2)
      }
    })

    it('retries only a failed installation after its bounded attempts are exhausted', async () => {
      const failed = fromPartition('persist:orca-browser')
      const healthy = fromPartition('persist:orca-browser-session-iso')
      for (let attempt = 0; attempt < 3; attempt++) {
        failed.resolveProxy.mockRejectedValueOnce(new Error('native proxy failure'))
      }
      const initialFailure = expect(applyProxySettingsToSession(failed, {})).rejects.toThrow(
        'native proxy failure'
      )
      await applyProxySettingsToSession(healthy, {})
      await initialFailure

      await awaitBrowserSessionProxies(PROFILES)

      expect(failed.resolveProxy).toHaveBeenCalledTimes(4)
      expect(healthy.resolveProxy).toHaveBeenCalledOnce()
    })

    it('awaits every installation and preserves failed-partition warnings and retry budget', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const failed = fromPartition('persist:orca-browser')
      failed.resolveProxy.mockRejectedValue(new Error('native proxy failure'))
      await expect(applyProxySettingsToSession(failed, {})).rejects.toThrow('native proxy failure')
      const healthy = fromPartition('persist:orca-browser-session-iso')
      let finishHealthy: (() => void) | undefined
      healthy.resolveProxy.mockImplementationOnce(
        () => new Promise<string>((resolve) => (finishHealthy = () => resolve('DIRECT')))
      )
      const installation = applyProxySettingsToSession(healthy, {})
      let settled = false
      const startup = awaitBrowserSessionProxies(PROFILES).finally(() => (settled = true))
      const failure = expect(startup).rejects.toThrow('persist:orca-browser')

      await vi.waitFor(() => expect(failed.resolveProxy).toHaveBeenCalledTimes(6))
      expect(settled).toBe(false)
      finishHealthy?.()
      await Promise.all([installation, failure])

      expect(healthy.resolveProxy).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[proxy] Failed to apply proxy to browser partition',
        'persist:orca-browser'
      )
    })

    it.each([false, true])(
      'awaits the newest settings write when the initial policy fails=%s',
      async (initialFails) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const profiles = PROFILES.slice(0, 1)
        const sess = fromPartition('persist:orca-browser')
        let settings: NetworkProxySettings = {}
        setBrowserNetworkProxySettingsResolver(() => settings)
        let finishInitial: (() => void) | undefined
        sess.resolveProxy.mockImplementationOnce(
          () =>
            new Promise<string>((resolve, reject) => {
              finishInitial = () =>
                initialFails ? reject(new Error('native proxy failure')) : resolve('DIRECT')
            })
        )
        if (initialFails) {
          sess.resolveProxy.mockRejectedValueOnce(new Error('native proxy failure'))
          sess.resolveProxy.mockRejectedValueOnce(new Error('native proxy failure'))
        }
        let finishWrite: (() => void) | undefined
        sess.setProxy.mockImplementationOnce(
          () => new Promise<void>((resolve) => (finishWrite = resolve))
        )
        const installation = applyProxySettingsToSession(sess, {}).catch((error: unknown) => error)
        let settled = false
        const startup = awaitBrowserSessionProxies(profiles).then(() => (settled = true))
        await vi.waitFor(() => expect(sess.resolveProxy).toHaveBeenCalledOnce())
        settings = { httpProxyUrl: 'http://fresh.example:8080' }
        const sweep = applyBrowserSessionProxies(profiles, settings)
        finishInitial?.()

        await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledOnce())
        expect(settled).toBe(false)
        finishWrite?.()
        await Promise.all([installation, startup, sweep])

        expect(sess.resolveProxy).toHaveBeenCalledTimes(initialFails ? 3 : 1)
        expect(sess.setProxy).toHaveBeenCalledExactlyOnceWith({
          mode: 'fixed_servers',
          proxyRules: 'http://fresh.example:8080'
        })
        expect(warn).not.toHaveBeenCalled()
      }
    )
  })
})
