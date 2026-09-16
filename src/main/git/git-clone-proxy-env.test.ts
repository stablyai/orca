import { describe, expect, it } from 'vitest'
import { gitCloneEnvWithProxy } from './git-clone-proxy-env'

describe('gitCloneEnvWithProxy', () => {
  it('merges an http proxy into the git env', () => {
    const env = gitCloneEnvWithProxy(
      { PATH: '/usr/bin' },
      { httpProxyUrl: 'http://proxy.example:8080' },
      'linux'
    )
    expect(env.HTTP_PROXY).toBe('http://proxy.example:8080')
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080')
    expect(env.ALL_PROXY).toBe('http://proxy.example:8080')
    expect(env.http_proxy).toBe('http://proxy.example:8080')
    expect(env.https_proxy).toBe('http://proxy.example:8080')
    expect(env.all_proxy).toBe('http://proxy.example:8080')
    // Original keys are preserved.
    expect(env.PATH).toBe('/usr/bin')
  })

  it('merges a socks5 proxy so libcurl-backed git routes through it', () => {
    const env = gitCloneEnvWithProxy({}, { httpProxyUrl: 'socks5://127.0.0.1:1080' }, 'linux')
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1080')
    expect(env.HTTPS_PROXY).toBe('socks5://127.0.0.1:1080')
  })

  it('applies bypass rules as NO_PROXY', () => {
    const env = gitCloneEnvWithProxy(
      {},
      { httpProxyUrl: 'http://proxy.example:8080', httpProxyBypassRules: 'localhost;*.internal' },
      'linux'
    )
    expect(env.NO_PROXY).toBe('localhost,*.internal')
    expect(env.no_proxy).toBe('localhost,*.internal')
  })

  it('returns the env unchanged when no proxy is configured', () => {
    const original = { PATH: '/usr/bin' }
    expect(gitCloneEnvWithProxy(original, undefined, 'linux')).toBe(original)
    expect(gitCloneEnvWithProxy(original, {}, 'linux')).toBe(original)
    expect(gitCloneEnvWithProxy(original, { httpProxyUrl: '' }, 'linux')).toBe(original)
  })

  it('does not mutate WSLENV off win32', () => {
    const env = gitCloneEnvWithProxy({}, { httpProxyUrl: 'http://proxy.example:8080' }, 'darwin')
    expect(env.WSLENV).toBeUndefined()
  })

  it('forwards proxy keys into WSLENV on win32 so a WSL-routed clone receives them', () => {
    const env = gitCloneEnvWithProxy(
      {},
      { httpProxyUrl: 'http://proxy.example:8080', httpProxyBypassRules: 'localhost' },
      'win32'
    )
    const forwarded = new Set((env.WSLENV ?? '').split(':').filter(Boolean))
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'no_proxy']) {
      expect(forwarded.has(key)).toBe(true)
    }
  })

  it('leaves the env untouched on win32 when no proxy is set (no empty WSLENV)', () => {
    const original = {}
    const env = gitCloneEnvWithProxy(original, undefined, 'win32')
    expect(env).toBe(original)
    expect(env.WSLENV).toBeUndefined()
  })
})
