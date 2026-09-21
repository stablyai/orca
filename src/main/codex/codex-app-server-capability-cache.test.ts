import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS,
  CodexAppServerCapabilityCache,
  getCodexAppServerHostKey
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

  it('falls back on the first unsupported probe and skips the probe on later calls', async () => {
    const cache = new CodexAppServerCapabilityCache()
    const firstPreferred = vi.fn(() => Promise.reject(unsupportedError))
    await expect(
      cache.runWithFallback(
        'native',
        firstPreferred,
        () => Promise.resolve('first-fallback'),
        isUnsupported
      )
    ).resolves.toBe('first-fallback')
    expect(firstPreferred).toHaveBeenCalledTimes(1)

    const laterPreferred = vi.fn(() => Promise.resolve('unexpected-preferred'))
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isUnsupported
      )
    ).resolves.toBe('cached-fallback')
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isUnsupported
      )
    ).resolves.toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('isolates capability state per execution host', async () => {
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberUnsupported('wsl:Ubuntu', 1_000)

    expect(cache.shouldTry('wsl:Ubuntu', 1_001)).toBe(false)
    expect(cache.shouldTry('native', 1_001)).toBe(true)
    expect(cache.shouldTry('wsl:Debian', 1_001)).toBe(true)

    const nativePreferred = vi.fn(() => Promise.resolve('native-result'))
    await expect(
      cache.runWithFallback(
        'native',
        nativePreferred,
        () => Promise.resolve('unexpected'),
        isUnsupported
      )
    ).resolves.toBe('native-result')
    expect(nativePreferred).toHaveBeenCalledTimes(1)
  })

  it('drops known support when a later call reports the capability unsupported', async () => {
    const cache = new CodexAppServerCapabilityCache()
    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.resolve('supported'),
        () => Promise.resolve('unexpected'),
        isUnsupported
      )
    ).resolves.toBe('supported')
    expect(cache.isKnownSupported('native')).toBe(true)

    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.reject(unsupportedError),
        () => Promise.resolve('fallback'),
        isUnsupported
      )
    ).resolves.toBe('fallback')
    expect(cache.isKnownSupported('native')).toBe(false)

    const laterPreferred = vi.fn(() => Promise.resolve('unexpected-preferred'))
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isUnsupported
      )
    ).resolves.toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('rethrows transient errors without marking the host unsupported', async () => {
    const cache = new CodexAppServerCapabilityCache()
    const transient = new Error('spawn ETIMEDOUT')
    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.reject(transient),
        () => Promise.resolve('unexpected-fallback'),
        isUnsupported
      )
    ).rejects.toBe(transient)
    expect(cache.shouldTry('native', 2)).toBe(true)
  })

  // Why (#16441): grants no longer block the main thread, so two pane launches
  // can reach a cold host at once. Without dedupe each one pays its own
  // app-server session against a codex that has no such RPC surface.
  it('dedupes concurrent probes on one host to a single app-server session', async () => {
    const cache = new CodexAppServerCapabilityCache()
    let releaseProbe!: (error: unknown) => void
    const preferred = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          releaseProbe = reject
        })
    )
    const first = cache.runWithFallback(
      'native',
      preferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    const second = cache.runWithFallback(
      'native',
      preferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    await Promise.resolve()
    releaseProbe(unsupportedError)

    await expect(first).resolves.toBe('fallback')
    await expect(second).resolves.toBe('fallback')
    expect(preferred).toHaveBeenCalledTimes(1)
  })

  it('lets a waiter run its own work once the in-flight probe reports support', async () => {
    const cache = new CodexAppServerCapabilityCache()
    let releaseProbe!: (value: string) => void
    const firstPreferred = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseProbe = resolve
        })
    )
    const secondPreferred = vi.fn(() => Promise.resolve('second'))
    const first = cache.runWithFallback(
      'native',
      firstPreferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    const second = cache.runWithFallback(
      'native',
      secondPreferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    await Promise.resolve()
    releaseProbe('first')

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(secondPreferred).toHaveBeenCalledTimes(1)
  })

  it('isolates in-flight probes per host so a cold WSL distro never waits on native', async () => {
    const cache = new CodexAppServerCapabilityCache()
    const nativePreferred = vi.fn(() => new Promise<string>(() => {}))
    void cache.runWithFallback(
      'native',
      nativePreferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    const wslPreferred = vi.fn(() => Promise.resolve('wsl-result'))
    await expect(
      cache.runWithFallback(
        'wsl:Ubuntu',
        wslPreferred,
        () => Promise.resolve('fallback'),
        isUnsupported
      )
    ).resolves.toBe('wsl-result')
  })

  it('builds host keys that keep WSL distros apart', () => {
    expect(getCodexAppServerHostKey({ kind: 'native' })).toBe('native')
    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getCodexAppServerHostKey({ kind: 'wsl', distro: 'Debian' })).toBe('wsl:Debian')
  })
})
