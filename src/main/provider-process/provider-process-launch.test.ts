import { afterEach, describe, expect, it } from 'vitest'
import {
  resetProviderProxySettingsSourceForTests,
  resolveProviderChildEnv,
  setProviderProxySettingsSource
} from './provider-process-launch'

afterEach(() => {
  resetProviderProxySettingsSourceForTests()
})

describe('resolveProviderChildEnv proxy overlay', () => {
  it('applies the configured proxy env when a settings source is wired', () => {
    setProviderProxySettingsSource(() => ({
      httpProxyUrl: 'http://127.0.0.1:8080',
      httpProxyBypassRules: 'localhost;127.0.0.1'
    }))

    const env = resolveProviderChildEnv({}, { PATH: '/usr/bin' })

    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8080')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8080')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:8080')
    expect(env.http_proxy).toBe('http://127.0.0.1:8080')
    expect(env.https_proxy).toBe('http://127.0.0.1:8080')
    expect(env.all_proxy).toBe('http://127.0.0.1:8080')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(env.no_proxy).toBe('localhost,127.0.0.1')
  })

  it('beats an inherited proxy but not an explicit launch overlay', () => {
    setProviderProxySettingsSource(() => ({ httpProxyUrl: 'http://configured:8080' }))

    const env = resolveProviderChildEnv(
      { env: { HTTP_PROXY: 'http://explicit:9999' } },
      { HTTP_PROXY: 'http://inherited:1234', http_proxy: 'http://inherited:1234' }
    )

    expect(env.HTTP_PROXY).toBe('http://explicit:9999')
    expect(env.http_proxy).toBe('http://configured:8080')
    expect(env.HTTPS_PROXY).toBe('http://configured:8080')
  })

  it('adds no proxy keys when no source is wired or settings are empty', () => {
    const noSource = resolveProviderChildEnv({}, { PATH: '/usr/bin' })
    expect(Object.keys(noSource)).toEqual(['PATH'])

    setProviderProxySettingsSource(() => ({ httpProxyUrl: null }))
    const emptySettings = resolveProviderChildEnv({}, { PATH: '/usr/bin' })
    expect(Object.keys(emptySettings)).toEqual(['PATH'])
  })

  it('keeps an inherited machine proxy when Orca configures none', () => {
    setProviderProxySettingsSource(() => ({ httpProxyUrl: null }))

    const env = resolveProviderChildEnv({}, { HTTP_PROXY: 'http://machine:3128' })

    expect(env.HTTP_PROXY).toBe('http://machine:3128')
  })

  it('envToDelete still strips the applied proxy keys', () => {
    setProviderProxySettingsSource(() => ({ httpProxyUrl: 'http://configured:8080' }))

    const env = resolveProviderChildEnv({ envToDelete: ['HTTP_PROXY', 'HTTPS_PROXY'] }, {})

    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBe('http://configured:8080')
  })
})
