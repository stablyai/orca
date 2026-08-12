import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatSendError } from './use-mobile-native-chat-send-error'

type HookApi = ReturnType<typeof useMobileNativeChatSendError>

describe('useMobileNativeChatSendError', () => {
  let renderer: ReactTestRenderer | null = null
  const apiRef = { current: null as HookApi | null }

  const showToast = vi.fn()

  function Harness({
    scopeKey,
    bannerMounted = true
  }: {
    scopeKey: string | null
    bannerMounted?: boolean
  }): null {
    const api = useMobileNativeChatSendError({ scopeKey, showToast })
    api.bannerMountedRef.current = bannerMounted
    apiRef.current = api
    return null
  }

  function api(): HookApi {
    if (!apiRef.current) {
      throw new Error('Harness was not rendered')
    }
    return apiRef.current
  }

  async function render(scopeKey: string | null = 'terminal-1'): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { scopeKey }))
    })
  }

  beforeEach(() => {
    apiRef.current = null
    showToast.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('holds a failure for four seconds, then drops it', async () => {
    await render()
    await act(async () => api().show('a'))
    expect(api().message).toBe('a')

    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(api().message).toBeNull()
  })

  it('restarts the hold when a second failure lands mid-hold', async () => {
    await render()
    await act(async () => api().show('a'))
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    await act(async () => api().show('b'))

    // The first failure's timer must not survive to clear the second message.
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(api().message).toBe('b')

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(api().message).toBeNull()
  })

  it('clears immediately and cancels the pending hold', async () => {
    await render()
    await act(async () => api().show('a'))
    await act(async () => api().clear())
    expect(api().message).toBeNull()

    await act(async () => api().show('b'))
    await act(async () => api().clear())
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(api().message).toBeNull()
  })

  it('drops a held failure when the scope changes', async () => {
    await render('terminal-1')
    await act(async () => api().show('a'))
    expect(api().message).toBe('a')

    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-2' }))
    })
    expect(api().message).toBeNull()
  })

  it('falls back to the toast when the banner is not mounted', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { scopeKey: 'terminal-1', bannerMounted: false }))
    })
    // A deferred failure landing after the user left chat must still be seen.
    await act(async () => api().show('Delivery unconfirmed'))

    expect(showToast).toHaveBeenCalledWith('Delivery unconfirmed', 1600)
    expect(api().message).toBeNull()
  })

  it('toasts a deferred failure that resolves after the user switched tabs', async () => {
    await render('terminal-1')
    // Captured while tab A was live; a 20s unconfirmed send resolves much later.
    const showFromTabA = api().show

    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-2' }))
    })
    await act(async () => showFromTabA('Message not sent'))

    // The banner belongs to terminal-2 now, so A's failure must not paint there.
    expect(api().message).toBeNull()
    expect(showToast).toHaveBeenCalledWith('Message not sent', 1600)
  })

  it('does not let a stale scope clear the banner the live scope is showing', async () => {
    await render('terminal-1')
    const clearFromTabA = api().clear

    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-2' }))
    })
    await act(async () => api().show('b'))
    // An accepted card action from tab A resolving late must not retire B's warning.
    await act(async () => clearFromTabA())

    expect(api().message).toBe('b')
  })

  it('toasts a failure that resolves after the route unmounted', async () => {
    await render()
    const showWhileMounted = api().show

    act(() => renderer?.unmount())
    renderer = null
    // The route writes bannerMountedRef during render, so an unmount leaves it
    // stuck true — the failure would target a banner that no longer exists.
    await act(async () => showWhileMounted('Delivery unconfirmed'))

    expect(showToast).toHaveBeenCalledWith('Delivery unconfirmed', 1600)
  })

  it('does not fire the hold timer after unmount', async () => {
    await render()
    await act(async () => api().show('a'))

    const errors: unknown[] = []
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      errors.push(args[0])
      original(...args)
    })
    try {
      act(() => renderer?.unmount())
      renderer = null
      act(() => {
        vi.advanceTimersByTime(4000)
      })
    } finally {
      spy.mockRestore()
    }
    expect(errors).toEqual([])
  })
})
