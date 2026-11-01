import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES,
  CodexAppServerCapabilityCache
} from './codex-app-server-capability-cache'

const unsupportedError = new Error('unsupported')
const isUnsupported = (error: unknown): boolean => error === unsupportedError

describe('CodexAppServerCapabilityCache', () => {
  it('bounds host capability state during WSL distro churn', () => {
    const cache = new CodexAppServerCapabilityCache()
    cache.rememberUnsupported('wsl:Alpine', 1_000)
    for (let index = 0; index < CODEX_APP_SERVER_CAPABILITY_MAX_ENTRIES + 4; index += 1) {
      cache.rememberUnsupported(`wsl:distro-${index}`, 1_000)
    }

    expect(cache.shouldTry('wsl:Alpine', 1_001)).toBe(true)
  })

  it('drops known support when a later call reports the capability unsupported', async () => {
    const cache = new CodexAppServerCapabilityCache()
    await expect(
      cache.runWithFallback(
        'wsl:Alpine',
        () => Promise.resolve('supported'),
        () => Promise.resolve('unexpected'),
        isUnsupported
      )
    ).resolves.toBe('supported')
    expect(cache.isKnownSupported('wsl:Alpine')).toBe(true)

    await expect(
      cache.runWithFallback(
        'wsl:Alpine',
        () => Promise.reject(unsupportedError),
        () => Promise.resolve('fallback'),
        isUnsupported
      )
    ).resolves.toBe('fallback')
    expect(cache.isKnownSupported('wsl:Alpine')).toBe(false)

    const laterPreferred = vi.fn(() => Promise.resolve('unexpected-preferred'))
    await expect(
      cache.runWithFallback(
        'wsl:Alpine',
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
        'wsl:Alpine',
        () => Promise.reject(transient),
        () => Promise.resolve('unexpected-fallback'),
        isUnsupported
      )
    ).rejects.toBe(transient)
    expect(cache.shouldTry('wsl:Alpine', 2)).toBe(true)
  })

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
      'wsl:Alpine',
      preferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    const second = cache.runWithFallback(
      'wsl:Alpine',
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
      'wsl:Alpine',
      firstPreferred,
      () => Promise.resolve('fallback'),
      isUnsupported
    )
    const second = cache.runWithFallback(
      'wsl:Alpine',
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
      'wsl:Alpine',
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
})
