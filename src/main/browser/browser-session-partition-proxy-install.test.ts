import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionsByPartition, fromPartitionMock } = vi.hoisted(() => {
  const sessionsByPartition = new Map<string, Record<string, ReturnType<typeof vi.fn>>>()
  const fromPartitionMock = vi.fn((partition: string) => {
    const existing = sessionsByPartition.get(partition)
    if (existing) {
      return existing
    }
    const created = {
      resolveProxy: vi.fn(async () => 'DIRECT'),
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
      getUserAgent: vi.fn(() => 'Mozilla/5.0 Electron/43.0.0 Orca/1.0'),
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn()
    }
    sessionsByPartition.set(partition, created)
    return created
  })
  return { sessionsByPartition, fromPartitionMock }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT'), setProxy: vi.fn(async () => {}) },
    fromPartition: fromPartitionMock
  }
}))
vi.mock('./browser-manager', () => ({
  browserManager: {
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: vi.fn(),
    handleGuestWillDownload: vi.fn()
  }
}))
vi.mock('./browser-media-access', () => ({
  hasSystemMediaAccess: vi.fn(() => false),
  requestSystemMediaAccess: vi.fn(async () => false)
}))
vi.mock('./browser-session-ua', () => ({
  cleanElectronUserAgent: vi.fn((ua: string) => ua),
  setupClientHintsOverride: vi.fn()
}))
vi.mock('./browser-session-user-agent-mode', () => ({
  setBrowserSessionUserAgentMode: vi.fn(),
  clearBrowserSessionUserAgentMode: vi.fn()
}))
vi.mock('./browser-webauthn-access', () => ({
  allowsBrowserWebAuthnPermission: vi.fn(() => false),
  clearBrowserWebAuthnAccessHandlers: vi.fn(),
  installBrowserWebAuthnAccessHandlers: vi.fn()
}))

import {
  clearBrowserSessionPartitionPolicies,
  forgetBrowserSessionPartitionConfiguration,
  installBrowserSessionPartitionPolicies
} from './browser-session-partition-policies'
import {
  applyBrowserSessionProxies,
  setBrowserNetworkProxySettingsResolver
} from './browser-session-proxy'
import { handleElectronProxyLogin } from '../network/electron-proxy-credentials'

let partitionCounter = 0
function nextProfile() {
  partitionCounter += 1
  const partition = `persist:orca-browser-session-install-${partitionCounter}`
  return {
    id: `p${partitionCounter}`,
    scope: 'isolated' as const,
    partition,
    label: 'p',
    source: null
  }
}

describe('installBrowserSessionPartitionPolicies proxy wiring', () => {
  beforeEach(() => {
    setBrowserNetworkProxySettingsResolver(null)
    // Why: the host shell may export proxy vars, which would otherwise stand in for the setting.
    for (const key of [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy'
    ]) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Why (STA-4779): the installer is the single funnel every browser partition passes through.
  // If it stops applying the proxy, embedded tabs silently go direct again.
  it('applies the app-wide proxy to a newly configured partition', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()

    await installBrowserSessionPartitionPolicies(profile)

    expect(sessionsByPartition.get(profile.partition)?.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080'
    })
  })

  it('leaves the partition on the system proxy when neither settings nor env configure one', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: '',
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()

    await installBrowserSessionPartitionPolicies(profile)

    expect(sessionsByPartition.get(profile.partition)?.setProxy).not.toHaveBeenCalled()
  })

  it('does not report a new partition ready until Electron finishes applying its proxy', async () => {
    let finishWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()
    const sess = fromPartitionMock(profile.partition)
    sess.setProxy.mockImplementation(() => new Promise<void>((resolve) => (finishWrite = resolve)))

    let ready = false
    const installation = installBrowserSessionPartitionPolicies(profile).then(() => (ready = true))
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    expect(ready).toBe(false)

    finishWrite?.()
    await installation
    expect(ready).toBe(true)
  })

  it('re-applies the proxy when policies are already installed', async () => {
    let proxyUrl = 'http://first.example:8080'
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: proxyUrl,
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()

    await installBrowserSessionPartitionPolicies(profile)
    proxyUrl = 'http://second.example:8080'
    await installBrowserSessionPartitionPolicies(profile)

    expect(sessionsByPartition.get(profile.partition)?.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://first.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://second.example:8080' }]
    ])
  })

  it('forgets deleted partition configuration without weakening its proxy guard', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: 'http://proxy.example:8080' }))
    const profile = nextProfile()
    const sess = fromPartitionMock(profile.partition)

    await installBrowserSessionPartitionPolicies(profile)
    forgetBrowserSessionPartitionConfiguration(profile.partition)
    await installBrowserSessionPartitionPolicies(profile)

    expect(sess.setPermissionRequestHandler).toHaveBeenCalledTimes(2)
    expect(sess.setProxy).toHaveBeenCalledTimes(1)
  })

  it('recovers partition readiness after one transient proxy rejection', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()
    const sess = fromPartitionMock(profile.partition)
    sess.setProxy.mockRejectedValueOnce(new Error('transient proxy failure'))

    await expect(installBrowserSessionPartitionPolicies(profile)).resolves.toBeUndefined()

    expect(sess.setProxy).toHaveBeenCalledTimes(2)
  })

  it('forgets failed startup credentials and restores them after recovery', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'http://alice:secret@proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const profile = nextProfile()
    const sess = fromPartitionMock(profile.partition)
    sess.closeAllConnections.mockRejectedValue(new Error('proxy settlement failed'))

    await expect(installBrowserSessionPartitionPolicies(profile)).rejects.toThrow(
      'proxy settlement failed'
    )
    const failedCallback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
      { session: sess } as never,
      {} as never,
      { isProxy: true, host: 'proxy.example', port: 8080 },
      failedCallback
    )
    expect(failedCallback).not.toHaveBeenCalled()

    sess.closeAllConnections.mockResolvedValue(undefined)
    await expect(installBrowserSessionPartitionPolicies(profile)).resolves.toBeUndefined()
    const recoveredCallback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
      { session: sess } as never,
      {} as never,
      { isProxy: true, host: 'proxy.example', port: 8080 },
      recoveredCallback
    )
    expect(recoveredCallback).toHaveBeenCalledWith('alice', 'secret')
  })

  it('cancels an in-flight policy retry when partition policies are cleared', async () => {
    let proxyUrl = 'http://old.example:8080'
    let finishWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const profile = nextProfile()
    const sess = fromPartitionMock(profile.partition)
    sess.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    )

    const installation = installBrowserSessionPartitionPolicies(profile)
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    clearBrowserSessionPartitionPolicies(profile.partition, sess as never)
    proxyUrl = 'http://new.example:8080'
    await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
    finishWrite?.()
    await installation

    expect(sess.setProxy).toHaveBeenCalledTimes(1)
  })
})
