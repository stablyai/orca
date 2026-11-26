import { afterEach, describe, expect, it, vi } from 'vitest'
import { setNetworkProxySettingsSource } from '../browser/network/execution-routes/browser-network-proxy-settings-source'
import {
  parseSystemProxyRule,
  resolveConfiguredOrSystemProxyEnv,
  withConfiguredProxyEnv
} from './configured-proxy-child-env'
import { setDefaultProxySessionResolver, type ProxySession } from './electron-default-proxy-session'

const SETTINGS_PROXY = 'http://proxy.example:3128'

function mockProxySession(resolveProxy: ProxySession['resolveProxy']): void {
  setDefaultProxySessionResolver(() => ({
    resolveProxy,
    setProxy: async () => {}
  }))
}

describe('withConfiguredProxyEnv', () => {
  afterEach(() => {
    setNetworkProxySettingsSource(null)
    setDefaultProxySessionResolver(null)
    vi.useRealTimers()
  })

  function configureSettingsProxy(): void {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: SETTINGS_PROXY,
      httpProxyBypassRules: 'localhost;10.0.0.0/8'
    }))
  }

  it('keeps an inherited HTTPS_PROXY and does not add the Settings proxy', () => {
    configureSettingsProxy()
    const callerEnv = { PATH: '/usr/bin', HTTPS_PROXY: 'http://inherited:1234', NO_PROXY: '*' }

    expect(withConfiguredProxyEnv(callerEnv)).toBe(callerEnv)
  })

  it('detects inherited proxy keys case-insensitively', () => {
    configureSettingsProxy()
    const callerEnv = { Https_Proxy: 'http://inherited:1234' }

    expect(withConfiguredProxyEnv(callerEnv)).toBe(callerEnv)
  })

  it('unions inherited NO_PROXY entries with the Settings bypass list', () => {
    configureSettingsProxy()
    const env = withConfiguredProxyEnv({ no_proxy: 'corp.internal, localhost' })

    const expectedNoProxy = 'corp.internal,localhost,10.0.0.0/8'
    expect(env?.NO_PROXY).toBe(expectedNoProxy)
    expect(env?.no_proxy).toBe(expectedNoProxy)
  })

  it('applies the Settings proxy when nothing is inherited', () => {
    configureSettingsProxy()
    const env = withConfiguredProxyEnv({ PATH: '/usr/bin', HTTPS_PROXY: '' })

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HTTP_PROXY: SETTINGS_PROXY,
      HTTPS_PROXY: SETTINGS_PROXY,
      https_proxy: SETTINGS_PROXY,
      ALL_PROXY: SETTINGS_PROXY,
      NO_PROXY: 'localhost,10.0.0.0/8',
      no_proxy: 'localhost,10.0.0.0/8'
    })
  })

  it('skips socks:// and socks4:// proxies that glab cannot use', () => {
    const callerEnv = { PATH: '/usr/bin' }
    for (const httpProxyUrl of ['socks://proxy.example:1080', 'socks4://proxy.example:1080']) {
      setNetworkProxySettingsSource(() => ({ httpProxyUrl, httpProxyBypassRules: '' }))
      expect(withConfiguredProxyEnv(callerEnv)).toBe(callerEnv)
    }
  })

  it('applies a socks5:// Settings proxy', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'socks5://proxy.example:1080',
      httpProxyBypassRules: ''
    }))

    expect(withConfiguredProxyEnv({ PATH: '/usr/bin' })).toMatchObject({
      HTTPS_PROXY: 'socks5://proxy.example:1080',
      ALL_PROXY: 'socks5://proxy.example:1080'
    })
  })

  it('returns the caller env unchanged when no Settings proxy is configured', () => {
    const callerEnv = { PATH: '/usr/bin' }

    expect(withConfiguredProxyEnv(callerEnv)).toBe(callerEnv)
    setNetworkProxySettingsSource(() => ({ httpProxyUrl: '', httpProxyBypassRules: '' }))
    expect(withConfiguredProxyEnv(callerEnv)).toBe(callerEnv)
    expect(withConfiguredProxyEnv(undefined)).toBeUndefined()
  })
})

describe('parseSystemProxyRule', () => {
  it('extracts Go-supported proxy schemes and DIRECT fallback flags', () => {
    expect(parseSystemProxyRule('PROXY 127.0.0.1:7890; DIRECT')).toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      hasDirectFallback: true
    })
    expect(parseSystemProxyRule('HTTPS proxy.corp:8443')).toEqual({
      proxyUrl: 'https://proxy.corp:8443',
      hasDirectFallback: false
    })
    expect(parseSystemProxyRule('SOCKS5 [::1]:1080')).toEqual({
      proxyUrl: 'socks5://[::1]:1080',
      hasDirectFallback: false
    })
    expect(parseSystemProxyRule('SOCKS 127.0.0.1:1080; PROXY 127.0.0.1:7890')).toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      hasDirectFallback: false
    })
    expect(parseSystemProxyRule('DIRECT; PROXY 127.0.0.1:7890')).toEqual({
      proxyUrl: null,
      hasDirectFallback: true
    })
    expect(parseSystemProxyRule('DIRECT')).toEqual({
      proxyUrl: null,
      hasDirectFallback: true
    })
  })
})

describe('resolveConfiguredOrSystemProxyEnv', () => {
  afterEach(() => {
    setNetworkProxySettingsSource(null)
    setDefaultProxySessionResolver(null)
    vi.useRealTimers()
  })

  it('resolves the OS system proxy when neither shell env nor Settings proxy is set', async () => {
    const requestedUrls: string[] = []
    mockProxySession(async (url) => {
      requestedUrls.push(url)
      return 'PROXY 127.0.0.1:7897; DIRECT'
    })

    const resolved = await resolveConfiguredOrSystemProxyEnv(
      { PATH: '/usr/bin', NO_PROXY: 'corp.internal' },
      { targetUrl: 'https://daily-cloudcode-pa.googleapis.com', settings: null }
    )

    expect(requestedUrls).toEqual(['https://daily-cloudcode-pa.googleapis.com'])
    expect(resolved.usedSystemProxy).toBe(true)
    expect(resolved.hasDirectFallback).toBe(true)
    expect(resolved.env).toMatchObject({
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      ALL_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'corp.internal',
      no_proxy: 'corp.internal'
    })
  })

  it('prefers inherited shell proxy and explicit Settings proxy without calling resolveProxy', async () => {
    let resolveCalls = 0
    mockProxySession(async () => {
      resolveCalls += 1
      return 'PROXY 127.0.0.1:7897'
    })

    const inheritedEnv = { PATH: '/usr/bin', HTTPS_PROXY: 'http://inherited:1234' }
    const fromInherited = await resolveConfiguredOrSystemProxyEnv(inheritedEnv, {
      targetUrl: 'https://daily-cloudcode-pa.googleapis.com',
      settings: null
    })
    expect(fromInherited).toEqual({
      env: inheritedEnv,
      usedSystemProxy: false,
      hasDirectFallback: false
    })

    const fromSettings = await resolveConfiguredOrSystemProxyEnv(
      { PATH: '/usr/bin' },
      {
        targetUrl: 'https://daily-cloudcode-pa.googleapis.com',
        settings: { httpProxyUrl: SETTINGS_PROXY, httpProxyBypassRules: '' }
      }
    )
    expect(fromSettings.usedSystemProxy).toBe(false)
    expect(fromSettings.env.HTTPS_PROXY).toBe(SETTINGS_PROXY)

    const unsupportedSettingsEnv = { PATH: '/usr/bin' }
    const fromUnsupportedSettings = await resolveConfiguredOrSystemProxyEnv(
      unsupportedSettingsEnv,
      {
        targetUrl: 'https://daily-cloudcode-pa.googleapis.com',
        settings: { httpProxyUrl: 'socks4://proxy.example:1080', httpProxyBypassRules: '' }
      }
    )
    expect(fromUnsupportedSettings).toEqual({
      env: unsupportedSettingsEnv,
      usedSystemProxy: false,
      hasDirectFallback: false
    })
    expect(resolveCalls).toBe(0)
  })

  it('falls back to unproxied env when system proxy resolution times out', async () => {
    vi.useFakeTimers()
    mockProxySession(() => new Promise<string>(() => {}))

    const callerEnv = { PATH: '/usr/bin' }
    const pending = resolveConfiguredOrSystemProxyEnv(callerEnv, {
      targetUrl: 'https://daily-cloudcode-pa.googleapis.com',
      settings: null
    })
    await vi.advanceTimersByTimeAsync(1_500)

    await expect(pending).resolves.toEqual({
      env: callerEnv,
      usedSystemProxy: false,
      hasDirectFallback: false
    })
  })
})
