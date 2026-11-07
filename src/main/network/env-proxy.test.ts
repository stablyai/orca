import { describe, expect, it } from 'vitest'
import { isBypassedByNoProxy, resolveEnvProxy } from './env-proxy'

describe('resolveEnvProxy', () => {
  it('returns null when no proxy variable is set', () => {
    expect(resolveEnvProxy('https://login.onorca.dev/x', {})).toBeNull()
  })

  it('picks the variable that matches the URL scheme', () => {
    const env = { HTTPS_PROXY: 'http://secure:3128', HTTP_PROXY: 'http://plain:3128' }
    expect(resolveEnvProxy('https://a.example', env)?.url).toBe('http://secure:3128')
    expect(resolveEnvProxy('wss://a.example/ws', env)?.url).toBe('http://secure:3128')
    expect(resolveEnvProxy('http://a.example', env)?.url).toBe('http://plain:3128')
    expect(resolveEnvProxy('ws://a.example', env)?.url).toBe('http://plain:3128')
  })

  it('prefers the lowercase variable and falls back to ALL_PROXY', () => {
    expect(
      resolveEnvProxy('https://a.example', {
        https_proxy: 'http://low:1',
        HTTPS_PROXY: 'http://up:1'
      })?.url
    ).toBe('http://low:1')
    expect(resolveEnvProxy('https://a.example', { ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({
      url: 'socks5://127.0.0.1:1080',
      scheme: 'socks5'
    })
  })

  it.each(['http', 'https', 'socks4', 'socks5', 'socks5h'])('accepts the %s scheme', (scheme) => {
    expect(resolveEnvProxy('https://a.example', { HTTPS_PROXY: `${scheme}://p:9` })?.scheme).toBe(
      scheme
    )
  })

  it('treats a bare host:port as an HTTP proxy', () => {
    expect(resolveEnvProxy('https://a.example', { HTTPS_PROXY: 'proxy.corp:8080' })).toEqual({
      url: 'http://proxy.corp:8080',
      scheme: 'http'
    })
  })

  it('ignores unsupported schemes, garbage, and non-http targets', () => {
    expect(resolveEnvProxy('https://a.example', { HTTPS_PROXY: 'ftp://p:1' })).toBeNull()
    expect(resolveEnvProxy('https://a.example', { HTTPS_PROXY: 'http://' })).toBeNull()
    expect(resolveEnvProxy('not a url', { HTTPS_PROXY: 'http://p:1' })).toBeNull()
    expect(resolveEnvProxy('file:///tmp/x', { HTTPS_PROXY: 'http://p:1' })).toBeNull()
  })

  it('skips the proxy for NO_PROXY hosts', () => {
    const env = { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'internal.corp' }
    expect(resolveEnvProxy('https://internal.corp/x', env)).toBeNull()
    expect(resolveEnvProxy('https://login.onorca.dev/x', env)?.url).toBe('http://p:1')
  })
})

describe('isBypassedByNoProxy', () => {
  const bypassed = (url: string, noProxy: string) =>
    isBypassedByNoProxy(new URL(url), { NO_PROXY: noProxy })

  it('matches a wildcard', () => {
    expect(bypassed('https://anything.example', '*')).toBe(true)
  })

  it('matches a domain and its subdomains, with or without a leading dot or star', () => {
    for (const entry of ['onorca.dev', '.onorca.dev', '*.onorca.dev']) {
      expect(bypassed('https://login.onorca.dev', entry)).toBe(true)
      expect(bypassed('https://onorca.dev', entry)).toBe(true)
      expect(bypassed('https://notonorca.dev', entry)).toBe(false)
    }
  })

  it('matches case-insensitively across comma and space separated lists', () => {
    expect(bypassed('https://Relay.OnOrca.dev', 'localhost, 10.0.0.1 RELAY.onorca.dev')).toBe(true)
    expect(bypassed('https://other.example', 'localhost, 10.0.0.1')).toBe(false)
  })

  it('applies a port rule only to that port, using scheme default ports', () => {
    expect(bypassed('https://a.example:8443', 'a.example:8443')).toBe(true)
    expect(bypassed('https://a.example', 'a.example:8443')).toBe(false)
    expect(bypassed('https://a.example', 'a.example:443')).toBe(true)
    expect(bypassed('wss://a.example', 'a.example:443')).toBe(true)
  })

  it('matches IP literals', () => {
    expect(bypassed('http://127.0.0.1:9', '127.0.0.1')).toBe(true)
    expect(bypassed('http://[::1]:9', '[::1]')).toBe(true)
    expect(bypassed('http://[::1]:9', '[::1]:9')).toBe(true)
    expect(bypassed('http://[::1]:9', '[::1]:10')).toBe(false)
  })

  it('reads the lowercase variable first and treats empty as unset', () => {
    expect(isBypassedByNoProxy(new URL('https://a.example'), { no_proxy: 'a.example' })).toBe(true)
    expect(isBypassedByNoProxy(new URL('https://a.example'), { NO_PROXY: '  ' })).toBe(false)
  })
})
