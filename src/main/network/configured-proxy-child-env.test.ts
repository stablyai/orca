import { afterEach, describe, expect, it } from 'vitest'
import { setNetworkProxySettingsSource } from '../browser/network/execution-routes/browser-network-proxy-settings-source'
import { withConfiguredProxyEnv } from './configured-proxy-child-env'

const SETTINGS_PROXY = 'http://proxy.example:3128'

describe('withConfiguredProxyEnv', () => {
  afterEach(() => {
    setNetworkProxySettingsSource(null)
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
