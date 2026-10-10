import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatSendError,
  mobileNativeChatSendErrorMessage,
  type MobileNativeChatCommandRefusalCauses
} from './use-mobile-native-chat-send-error'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import * as MobileNativeChatRenderData from './mobile-native-chat-render-data'

type HookApi = ReturnType<typeof useMobileNativeChatSendError>

describe('useMobileNativeChatSendError', () => {
  let renderer: ReactTestRenderer | null = null
  const apiRef = { current: null as HookApi | null }

  const showToast = vi.fn()

  function Harness({
    scopeKey,
    bannerMounted = true,
    causes = null
  }: {
    scopeKey: string | null
    bannerMounted?: boolean
    causes?: MobileNativeChatCommandRefusalCauses | null
  }): null {
    const api = useMobileNativeChatSendError({ scopeKey, showToast })
    api.bannerMountedRef.current = bannerMounted
    // As the route does each render, with what the chat shows.
    api.keepWhile(causes)
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

  async function showing(causes: MobileNativeChatCommandRefusalCauses): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-1', causes }))
    })
  }

  it('a /clear refused while the agent works goes when the agent stops, and stays gone', async () => {
    const line = "The agent is still working. Run /clear when it's done."
    await render()
    await showing({ working: true, prompt: false })
    await act(async () => api().show(line, { refusedWhile: 'working' }))
    expect(api().message).toBe(line)
    await showing({ working: true, prompt: false })
    expect(api().message).toBe(line)

    await showing({ working: false, prompt: false })
    expect(api().message).toBeNull()
    // Dropped, not hidden: the agent working again is not what that press was refused for.
    await showing({ working: true, prompt: false })
    expect(api().message).toBeNull()
  })

  it('a refusal behind a question goes once it is answered', async () => {
    await render()
    await showing({ working: false, prompt: true })
    await act(async () =>
      api().show("Answer the agent's question or approval, then run /clear.", {
        refusedWhile: 'prompt'
      })
    )
    await showing({ working: false, prompt: false })
    expect(api().message).toBeNull()
  })

  it('a failure naming nothing the phone shows, or background tasks it cannot see, stays', async () => {
    await render()
    await act(async () => api().show('Message not sent'))
    await showing({ working: false, prompt: false })
    expect(api().message).toBe('Message not sent')
    await act(async () =>
      api().show('Background tasks are still running.', { refusedWhile: 'background' })
    )
    await showing({ working: false, prompt: false })
    expect(api().message).toBe('Background tasks are still running.')
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

  it('holds the fact with its message, and clears it on another failure or expiry', async () => {
    const fact = { kind: 'notSignedIn', account: 'managed' } as const
    await render()
    await act(async () => api().show('Sign in', { failure: fact }))
    expect(api().failure).toEqual(fact)
    await act(async () => api().show('Stop failed'))
    expect(api().failure).toBeUndefined()
    await act(async () => api().show('Sign in', { failure: fact }))
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(api().failure).toBeUndefined()
    expect(api().message).toBeNull()
  })

  it('dedupes only the same failure and leaves unrelated banners free of transcript scans', () => {
    const failure = {
      kind: 'notSignedIn',
      account: 'managed',
      detail: { text: 'Key expired.', audience: 'person' }
    } as const
    const messages: NativeChatMessage[] = [
      {
        id: 'auth',
        role: 'system',
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Host guidance', failure }]
      }
    ]
    const scan = vi.spyOn(MobileNativeChatRenderData, 'foldMobileNativeChatMessages')
    expect(mobileNativeChatSendErrorMessage({ message: 'Stop failed' }, messages)).toBe(
      'Stop failed'
    )
    expect(scan).not.toHaveBeenCalled()
    expect(mobileNativeChatSendErrorMessage({ message: 'Sign in', failure }, messages)).toBe(
      'Your message was not sent.'
    )
    expect(
      mobileNativeChatSendErrorMessage(
        { message: 'Sign in', failure: { ...failure, account: 'system' } },
        messages
      )
    ).toBe('Sign in')
    expect(
      mobileNativeChatSendErrorMessage(
        {
          message: 'Sign in',
          failure: { ...failure, detail: { ...failure.detail, text: 'Other key.' } }
        },
        messages
      )
    ).toBe('Sign in')
    scan.mockRestore()
  })

  it('keeps sign-in guidance when only a hidden child states the failure', () => {
    const failure = { kind: 'notSignedIn' } as const
    const child: NativeChatMessage = {
      id: 'child-auth',
      agentId: 'codex-child',
      role: 'system',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Sign in to Codex', failure }]
    }
    expect(
      mobileNativeChatSendErrorMessage({ message: 'Sign in to Codex', failure }, [child])
    ).toBe('Sign in to Codex')
  })

  it('shortens guidance only while a matching row is visible', () => {
    const failure = { kind: 'notSignedIn' } as const
    const visible: NativeChatMessage = {
      id: 'parent-auth',
      role: 'system',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Sign in to Codex', failure }]
    }
    const child = { ...visible, id: 'child-auth', agentId: 'codex-child' }
    const error = { message: 'Sign in to Codex', failure }
    expect(mobileNativeChatSendErrorMessage(error, [child, visible])).toBe(
      'Your message was not sent.'
    )
    expect(mobileNativeChatSendErrorMessage(error, [child])).toBe(error.message)
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
    await act(async () => api().show('a', { failure: { kind: 'notSignedIn' } }))
    expect(api().message).toBe('a')

    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-2' }))
    })
    expect(api().message).toBeNull()
    expect(api().failure).toBeUndefined()
    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'terminal-1' }))
    })
    expect(api().message).toBeNull()
    expect(api().failure).toBeUndefined()
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
