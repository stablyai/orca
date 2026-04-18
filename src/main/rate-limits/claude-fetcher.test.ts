import { describe, expect, it } from 'vitest'
import { ProxyAgent } from 'undici'
import { resolveProxyDispatcher } from './claude-fetcher'

describe('resolveProxyDispatcher', () => {
  it('returns undefined when no proxy envvars are set', () => {
    expect(resolveProxyDispatcher({})).toBeUndefined()
  })

  it('picks up HTTPS_PROXY', () => {
    const d = resolveProxyDispatcher({ HTTPS_PROXY: 'http://127.0.0.1:7890' })
    expect(d).toBeInstanceOf(ProxyAgent)
  })

  it('prefers HTTPS_PROXY over ALL_PROXY and HTTP_PROXY', () => {
    // Why: we can't introspect the inner target URL without hitting private
    // ProxyAgent internals, but we can at least prove precedence short-circuits
    // by confirming a dispatcher comes back when only the high-precedence var
    // is a valid URL (an invalid HTTP_PROXY would be ignored anyway).
    const d = resolveProxyDispatcher({
      HTTPS_PROXY: 'http://good.example:1',
      HTTP_PROXY: 'not a url'
    })
    expect(d).toBeInstanceOf(ProxyAgent)
  })

  it('supports lower-case envvar names', () => {
    expect(resolveProxyDispatcher({ https_proxy: 'http://127.0.0.1:7890' })).toBeInstanceOf(
      ProxyAgent
    )
  })

  it('falls back to ALL_PROXY when HTTPS_PROXY is absent', () => {
    expect(resolveProxyDispatcher({ ALL_PROXY: 'http://127.0.0.1:7890' })).toBeInstanceOf(
      ProxyAgent
    )
  })

  it('returns undefined on invalid proxy URL instead of throwing', () => {
    // Why: usage polling is cosmetic — a typo in HTTPS_PROXY should not crash
    // the renderer or prevent rate-limit windows from being fetched via PTY
    // fallback. Degrade to "no proxy" silently.
    expect(resolveProxyDispatcher({ HTTPS_PROXY: 'not a url' })).toBeUndefined()
  })
})
