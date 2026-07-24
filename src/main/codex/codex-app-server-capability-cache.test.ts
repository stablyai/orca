import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS,
  CodexAppServerCapabilityCache,
  getCodexAppServerHostKey,
  MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS,
  MAX_CODEX_APP_SERVER_HOST_KEY_CODE_UNITS,
  type CodexAppServerHostKey
} from './codex-app-server-capability-cache'

const unsupportedError = new Error('unsupported')
const isUnsupported = (error: unknown): boolean => error === unsupportedError

describe('CodexAppServerCapabilityCache', () => {
  it('retries a host after the compatibility interval', () => {
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberUnsupported('native', 1_000)

    expect(
      cache.shouldTry('native', 1_000 + CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS - 1)
    ).toBe(false)
    expect(cache.shouldTry('native', 1_000 + CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS)).toBe(
      true
    )
  })

  it('falls back on the first unsupported probe and skips the probe on later calls', () => {
    const cache = new CodexAppServerCapabilityCache()
    const firstPreferred = vi.fn(() => {
      throw unsupportedError
    })
    expect(
      cache.runWithFallbackSync('native', firstPreferred, () => 'first-fallback', isUnsupported, 5)
    ).toBe('first-fallback')
    expect(firstPreferred).toHaveBeenCalledTimes(1)

    // Why: probes are synchronous on the main thread, so they can never
    // overlap — back-to-back calls inside the retry window are the
    // "concurrent probe" equivalent and must share the first probe's result.
    const laterPreferred = vi.fn(() => 'unexpected-preferred')
    expect(
      cache.runWithFallbackSync('native', laterPreferred, () => 'cached-fallback', isUnsupported, 6)
    ).toBe('cached-fallback')
    expect(
      cache.runWithFallbackSync('native', laterPreferred, () => 'cached-fallback', isUnsupported, 7)
    ).toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('isolates capability state per execution host', () => {
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberUnsupported('wsl:Ubuntu', 1_000)

    expect(cache.shouldTry('wsl:Ubuntu', 1_001)).toBe(false)
    expect(cache.shouldTry('native', 1_001)).toBe(true)
    expect(cache.shouldTry('wsl:Debian', 1_001)).toBe(true)

    const nativePreferred = vi.fn(() => 'native-result')
    expect(
      cache.runWithFallbackSync('native', nativePreferred, () => 'unexpected', isUnsupported, 1_001)
    ).toBe('native-result')
    expect(nativePreferred).toHaveBeenCalledTimes(1)
  })

  it('drops known support when a later call reports the capability unsupported', () => {
    const cache = new CodexAppServerCapabilityCache()
    expect(
      cache.runWithFallbackSync(
        'native',
        () => 'supported',
        () => 'unexpected',
        isUnsupported,
        1
      )
    ).toBe('supported')
    expect(cache.isKnownSupported('native')).toBe(true)

    expect(
      cache.runWithFallbackSync(
        'native',
        () => {
          throw unsupportedError
        },
        () => 'fallback',
        isUnsupported,
        2
      )
    ).toBe('fallback')
    expect(cache.isKnownSupported('native')).toBe(false)

    const laterPreferred = vi.fn(() => 'unexpected-preferred')
    expect(
      cache.runWithFallbackSync('native', laterPreferred, () => 'cached-fallback', isUnsupported, 3)
    ).toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('rethrows transient errors without marking the host unsupported', () => {
    const cache = new CodexAppServerCapabilityCache()
    const transient = new Error('spawn ETIMEDOUT')
    expect(() =>
      cache.runWithFallbackSync(
        'native',
        () => {
          throw transient
        },
        () => 'unexpected-fallback',
        isUnsupported,
        1
      )
    ).toThrow(transient)
    expect(cache.shouldTry('native', 2)).toBe(true)
  })

  it('builds host keys that keep WSL distros apart', () => {
    expect(getCodexAppServerHostKey({ kind: 'native' })).toBe('native')
    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: 'Debian' })).toBe('wsl:Debian')
  })

  it('retains exactly the host limit and LRU-evicts on the next host', () => {
    const cache = new CodexAppServerCapabilityCache()
    const hostKeys = Array.from(
      { length: MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS },
      (_, index): CodexAppServerHostKey => `wsl:distro-${index}`
    )
    hostKeys.forEach((hostKey) => cache.rememberUnsupported(hostKey, 0))

    expect(cache.shouldTry(hostKeys[0], 1)).toBe(false)
    cache.rememberUnsupported('wsl:overflow', 0)

    expect(cache.shouldTry(hostKeys[0], 1)).toBe(false)
    expect(cache.shouldTry(hostKeys[1], 1)).toBe(true)
    expect(cache.shouldTry('wsl:overflow', 1)).toBe(false)
  })

  it('bounds oversized generated and direct host keys', () => {
    const exactDistro = 'x'.repeat(MAX_CODEX_APP_SERVER_HOST_KEY_CODE_UNITS - 'wsl:'.length)
    const oversizedDistro = `${exactDistro}x`

    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: exactDistro })).toBe(
      `wsl:${exactDistro}`
    )
    const firstDigest = getCodexAppServerHostKey({ kind: 'wsl', distro: oversizedDistro })
    expect(firstDigest).toMatch(/^wsl:sha256:[a-f0-9]{64}$/)
    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: oversizedDistro })).toBe(firstDigest)

    const directOversized = `wsl:${oversizedDistro}` as CodexAppServerHostKey
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberUnsupported(directOversized, 0)
    expect(cache.shouldTry(directOversized, 1)).toBe(false)
  })

  it('clear forgets supported and unsupported host state', () => {
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberSupported('native')
    cache.rememberUnsupported('wsl:Ubuntu', 0)

    cache.clear()

    expect(cache.isKnownSupported('native')).toBe(false)
    expect(cache.shouldTry('wsl:Ubuntu', 1)).toBe(true)
  })
})
