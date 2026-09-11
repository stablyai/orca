import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { localeState, reloadAppAsync } = vi.hoisted(() => ({
  localeState: { current: [{ languageTag: 'es-MX' }] },
  reloadAppAsync: vi.fn<() => Promise<void>>()
}))

vi.mock('expo', () => ({ reloadAppAsync }))
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en' }],
  useLocales: () => localeState.current
}))

import { useMobileLocaleReload } from './use-mobile-locale-reload'
import { mobileI18n } from './mobile-i18n'

describe('useMobileLocaleReload', () => {
  let renderer: ReactTestRenderer | null = null
  let consoleSpy: MockInstance

  function Harness(): null {
    useMobileLocaleReload()
    return null
  }

  async function selectLocale(languageTag: string): Promise<void> {
    localeState.current = [{ languageTag }]
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
  }

  async function advanceRetryTimer(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    reloadAppAsync.mockReset()
    localeState.current = [{ languageTag: 'es-MX' }]
    const original = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    const pendingTimerCount = vi.getTimerCount()
    vi.useRealTimers()
    consoleSpy.mockRestore()
    expect(pendingTimerCount).toBe(0)
  })

  it('retries when the native reload request rejects', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload unavailable'))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(reloadAppAsync).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(reloadAppAsync).toHaveBeenCalledTimes(2)
  })

  it('bounds retries when the native reload keeps rejecting', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload unavailable'))
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }

    expect(reloadAppAsync).toHaveBeenCalledTimes(3)

    localeState.current = [{ languageTag: 'ja-JP' }]
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    expect(reloadAppAsync).toHaveBeenCalledTimes(4)
  })

  it('caps retries for each locale for the hook lifetime', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload unavailable'))
    expect(mobileI18n.language).toBe('en')
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    await advanceRetryTimer()
    await advanceRetryTimer()
    expect(reloadAppAsync).toHaveBeenCalledTimes(3)

    await selectLocale('ja-JP')
    await advanceRetryTimer()
    await advanceRetryTimer()
    expect(reloadAppAsync).toHaveBeenCalledTimes(6)

    for (const languageTag of ['en-US', 'es-MX', 'ja-JP', 'es-MX', 'ja-JP']) {
      await selectLocale(languageTag)
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(reloadAppAsync).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries the current locale after an exhausted stale target rejects', async () => {
    let rejectThirdEsReload!: (error: Error) => void
    reloadAppAsync
      .mockRejectedValueOnce(new Error('reload unavailable'))
      .mockRejectedValueOnce(new Error('reload unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectThirdEsReload = reject
          })
      )
      .mockRejectedValue(new Error('reload unavailable'))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await advanceRetryTimer()
    await advanceRetryTimer()
    expect(reloadAppAsync).toHaveBeenCalledTimes(3)

    await selectLocale('ja-JP')
    await act(async () => {
      rejectThirdEsReload(new Error('reload unavailable'))
      await Promise.resolve()
    })
    await advanceRetryTimer()

    expect(reloadAppAsync).toHaveBeenCalledTimes(4)
  })

  it('treats a successful reload as terminal after its target becomes stale', async () => {
    let resolveEsReload!: () => void
    reloadAppAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveEsReload = resolve
        })
    )
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    await selectLocale('ja-JP')
    await act(async () => {
      resolveEsReload()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(reloadAppAsync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts fresh attempt budgets after remount', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload unavailable'))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await advanceRetryTimer()
    await advanceRetryTimer()
    expect(reloadAppAsync).toHaveBeenCalledTimes(3)

    act(() => renderer?.unmount())
    renderer = null
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await advanceRetryTimer()
    await advanceRetryTimer()

    expect(reloadAppAsync).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a request that rejects after unmount', async () => {
    let rejectReload!: (error: Error) => void
    reloadAppAsync.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReload = reject
        })
    )
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      rejectReload(new Error('reload unavailable'))
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(reloadAppAsync).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending retry timer on unmount', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload unavailable'))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(vi.getTimerCount()).toBe(1)

    act(() => renderer?.unmount())
    renderer = null
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(reloadAppAsync).toHaveBeenCalledTimes(1)
  })

  it('retries a rejected request after locale preferences change while it is pending', async () => {
    let rejectReload!: (error: Error) => void
    reloadAppAsync.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReload = reject
        })
    )
    reloadAppAsync.mockResolvedValueOnce(undefined)
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(reloadAppAsync).toHaveBeenCalledTimes(1)

    localeState.current = [{ languageTag: 'ja-JP' }]
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    await act(async () => {
      rejectReload(new Error('reload unavailable'))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(reloadAppAsync).toHaveBeenCalledTimes(2)
  })
})
