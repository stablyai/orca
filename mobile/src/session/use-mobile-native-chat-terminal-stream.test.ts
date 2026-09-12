import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatTerminalStream } from './use-mobile-native-chat-terminal-stream'

describe('useMobileNativeChatTerminalStream', () => {
  let renderer: ReactTestRenderer | null = null
  let harnessRenderCount = 0
  const subscriptionsRef = { current: new Map<string, () => void>() }
  const subscribingRef = { current: new Set<string>() }
  const leaseOnlyRef = { current: new Set<string>() }
  const webReadyRef = { current: new Set(['terminal-1']) }
  const initializedRef = { current: new Set(['terminal-1']) }
  /** Mirrors the route's subscribe-time coverage guess, which is what decides whether
   *  the host opens a lease-only stream or a streaming one. */
  let subscribeOpensLeaseOnly = false
  const registerSubscription = (handle: string): void => {
    subscriptionsRef.current.set(handle, () => {})
    if (subscribeOpensLeaseOnly) {
      leaseOnlyRef.current.add(handle)
    } else {
      leaseOnlyRef.current.delete(handle)
    }
  }
  const subscribe = vi.fn(registerSubscription)
  const unsubscribe = vi.fn((handle: string) => {
    subscriptionsRef.current.delete(handle)
    leaseOnlyRef.current.delete(handle)
  })
  const notifyWebReadyRef = { current: (_handle: string, _wasAlreadyReady: boolean): void => {} }
  const notifyListedHandlesRef = { current: (_liveHandles: ReadonlySet<string>): void => {} }
  const hasTabsRecoveryNeedRef = { current: (): boolean => false }

  beforeEach(() => {
    subscriptionsRef.current = new Map([['terminal-1', () => {}]])
    subscribingRef.current = new Set()
    leaseOnlyRef.current = new Set()
    subscribeOpensLeaseOnly = false
    webReadyRef.current = new Set(['terminal-1'])
    initializedRef.current = new Set(['terminal-1'])
    harnessRenderCount = 0
    subscribe.mockClear()
    unsubscribe.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    showNativeChat,
    activeHandle = 'terminal-1',
    leaseReady = true,
    streamRevision = 0
  }: {
    showNativeChat: boolean
    activeHandle?: string
    leaseReady?: boolean
    streamRevision?: number
  }): null {
    harnessRenderCount += 1
    const stream = useMobileNativeChatTerminalStream({
      showNativeChat,
      activeHandle,
      activeTabType: 'terminal',
      leaseReady,
      streamRevision,
      subscriptionsRef,
      subscribingRef,
      leaseOnlyRef,
      webReadyRef,
      initializedRef,
      subscribe,
      unsubscribe
    })
    notifyWebReadyRef.current = stream.notifyWebReady
    notifyListedHandlesRef.current = stream.notifyListedHandles
    hasTabsRecoveryNeedRef.current = stream.hasTabsRecoveryNeed
    return null
  }

  /** One dead-PTY round trip: `end` tears the stream down (subscription gone, lease
   *  cleared), then the host's `subscribed` answer to the rearm briefly brings both
   *  back. Rendering only the `end` half is what let the shipped bound look sound. */
  async function playDeadPtyRoundTrip(revision: number): Promise<void> {
    subscriptionsRef.current.delete('terminal-1')
    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          showNativeChat: true,
          leaseReady: false,
          streamRevision: revision
        })
      )
    })
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: true, leaseReady: true, streamRevision: revision })
      )
    })
  }

  it('replaces output with a lease-only stream while covered, then restores output', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: false }))
    })
    await act(async () => {
      notifyWebReadyRef.current('terminal-1', false)
    })
    expect(harnessRenderCount).toBe(1)
    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: true }))
    })

    expect(unsubscribe).toHaveBeenNthCalledWith(1, 'terminal-1')
    expect(subscribe).toHaveBeenNthCalledWith(1, 'terminal-1')
    expect(initializedRef.current.has('terminal-1')).toBe(false)

    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: false }))
    })

    expect(unsubscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
    expect(subscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
  })

  /** What switchTab does synchronously on the tap, before the route re-renders: the
   *  coverage it reads still describes the chat tab being left, so the incoming
   *  terminal gets a lease-only subscribe — the shape that renders nothing. */
  function handOffToTerminalTwo(): void {
    subscribeOpensLeaseOnly = true
    subscribe('terminal-2')
    subscribeOpensLeaseOnly = false
    subscribe.mockClear()
    unsubscribe.mockClear()
  }

  it('trades a lease-only stream for output when a chat tab hands off to a terminal tab', async () => {
    webReadyRef.current.add('terminal-2')
    initializedRef.current.add('terminal-2')
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    handOffToTerminalTwo()

    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: false, activeHandle: 'terminal-2' })
      )
    })

    expect(unsubscribe).toHaveBeenCalledWith('terminal-2')
    expect(subscribe).toHaveBeenCalledWith('terminal-2')
    expect(leaseOnlyRef.current.has('terminal-2')).toBe(false)
    // The lease-only stream carried no scrollback, so xterm is empty — a stale
    // initialized mark would drop the replacement snapshot and keep the tab blank.
    expect(initializedRef.current.has('terminal-2')).toBe(false)
  })

  it('settles once a lease-only stream has been replaced by a full one', async () => {
    webReadyRef.current.add('terminal-2')
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    handOffToTerminalTwo()
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: false, activeHandle: 'terminal-2' })
      )
    })
    subscribe.mockClear()
    unsubscribe.mockClear()

    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          showNativeChat: false,
          activeHandle: 'terminal-2',
          streamRevision: 1
        })
      )
    })

    // A stream that renders is settled — resubscribing it again would be a loop.
    expect(subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('repairs a lease-only stream once its WebView reports ready', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    handOffToTerminalTwo()
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: false, activeHandle: 'terminal-2' })
      )
    })

    // Cold WebView: the resume must wait, and the route's own web-ready path bails
    // because the lease-only subscription already counts as live.
    expect(subscribe).not.toHaveBeenCalled()

    await act(async () => {
      webReadyRef.current.add('terminal-2')
      notifyWebReadyRef.current('terminal-2', false)
    })

    expect(unsubscribe).toHaveBeenCalledWith('terminal-2')
    expect(subscribe).toHaveBeenCalledWith('terminal-2')
  })

  it('keeps a covered lease-only stream instead of trading it for output (#10681)', async () => {
    subscribeOpensLeaseOnly = true
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    unsubscribe.mockClear()

    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: true, streamRevision: 1 }))
    })

    // Lease-only is the correct shape under chat; swapping it for output would drop
    // the input floor the composer holds.
    expect(subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(leaseOnlyRef.current.has('terminal-1')).toBe(true)
  })

  it('re-subscribes a covered stream torn down under chat (#10681)', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    unsubscribe.mockClear()
    // What a terminal.list prune / `end` frame does to the lease-only stream:
    // the subscription is gone and the lease drops with it.
    subscriptionsRef.current.delete('terminal-1')
    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: true, leaseReady: false }))
    })

    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('terminal-1')
    // Pins the rearm branch specifically: without it the action falls through to
    // the resume tail, which also subscribes — but drops coverage on the way.
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('stops rearming a handle whose stream never comes back (#10681)', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    // A dead PTY answers every subscribe with `subscribed`+`end`, so the stream is
    // gone again on each pass. Unbounded, that is a ~10s resubscribe loop.
    for (let revision = 1; revision <= 6; revision += 1) {
      subscriptionsRef.current.delete('terminal-1')
      await act(async () => {
        renderer?.update(
          createElement(Harness, {
            showNativeChat: true,
            leaseReady: false,
            streamRevision: revision
          })
        )
      })
    }

    expect(subscribe.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('does not charge the rearm budget for a subscribe its own gates turned away', async () => {
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { showNativeChat: true }))
      })
      subscribe.mockClear()
      // No client / no webview yet: the call returns without registering anything, so
      // it never reached the host and must not spend one of the three real tries.
      subscribe.mockImplementation(() => {})
      for (let revision = 1; revision <= 5; revision += 1) {
        subscriptionsRef.current.delete('terminal-1')
        await act(async () => {
          renderer?.update(
            createElement(Harness, {
              showNativeChat: true,
              leaseReady: false,
              streamRevision: revision
            })
          )
        })
      }

      expect(subscribe).toHaveBeenCalledTimes(5)
    } finally {
      subscribe.mockImplementation(registerSubscription)
    }
  })

  it('refills the rearm budget when terminal.list reports the handle again (#10681)', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    for (let revision = 1; revision <= 5; revision += 1) {
      subscriptionsRef.current.delete('terminal-1')
      await act(async () => {
        renderer?.update(
          createElement(Harness, {
            showNativeChat: true,
            leaseReady: false,
            streamRevision: revision
          })
        )
      })
    }
    subscribe.mockClear()
    // Budget is spent, so a further teardown signal alone changes nothing.
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: true, leaseReady: false, streamRevision: 6 })
      )
    })
    expect(subscribe).not.toHaveBeenCalled()

    // A dead-but-listed handle must not buy a new budget on every list refresh,
    // or the resubscribe loop this bound exists to stop comes straight back.
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-1']))
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })
    expect(subscribe).not.toHaveBeenCalled()

    // The handle actually went away and came back: it may have a live PTY once more.
    await act(async () => {
      notifyListedHandlesRef.current(new Set())
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })

    expect(subscribe).toHaveBeenCalledWith('terminal-1')
  })

  it('rearms on a teardown the lease cannot report (#10681)', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    // `end` with no preceding `subscribed` leaves the lease untouched, so
    // `leaseReady` holds its value and only the revision bump can re-run us.
    subscriptionsRef.current.delete('terminal-1')
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: true, leaseReady: true, streamRevision: 1 })
      )
    })

    expect(subscribe).toHaveBeenCalledWith('terminal-1')
  })

  it('does not let a dead PTY buy a new budget with its own `subscribed` ack', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    // The `subscribed` half re-runs the effect with the stream momentarily up, which
    // used to clear the attempt count — the loop refilled its own budget forever.
    for (let revision = 1; revision <= 6; revision += 1) {
      await playDeadPtyRoundTrip(revision)
    }

    expect(subscribe.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('refills the budget for a rearmed stream that outlives the teardown window', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { showNativeChat: true }))
      })
      subscribe.mockClear()
      for (let revision = 1; revision <= 3; revision += 1) {
        await playDeadPtyRoundTrip(revision)
      }
      expect(subscribe).toHaveBeenCalledTimes(3)

      // This rearm actually took: no `end` follows, so the stream is still up well
      // past the window a dead PTY's teardown would have landed in.
      subscribe.mockClear()
      subscriptionsRef.current.set('terminal-1', () => {})
      await act(async () => {
        renderer?.update(
          createElement(Harness, { showNativeChat: true, leaseReady: true, streamRevision: 4 })
        )
      })
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
      await playDeadPtyRoundTrip(5)

      expect(subscribe).toHaveBeenCalledWith('terminal-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an absence marker observed before the budget ran out', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    for (let revision = 1; revision <= 2; revision += 1) {
      await playDeadPtyRoundTrip(revision)
    }
    // The handle went away and came back with budget still left. Spending the marker
    // on that check left nothing to trade once the budget did run out — and a handle
    // the host keeps listing never goes absent again, so the composer locked for good.
    await act(async () => {
      notifyListedHandlesRef.current(new Set())
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })
    await playDeadPtyRoundTrip(3)
    subscribe.mockClear()
    await playDeadPtyRoundTrip(4)
    expect(subscribe).not.toHaveBeenCalled()

    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })

    expect(subscribe).toHaveBeenCalledWith('terminal-1')
  })

  it('keeps asking until a tab snapshot replaces the exhausted handle', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    for (let revision = 1; revision <= 3; revision += 1) {
      await playDeadPtyRoundTrip(revision)
    }
    // Exhausted but still listed: the host may yet answer, so nothing to recover from.
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })
    expect(hasTabsRecoveryNeedRef.current()).toBe(false)

    // Gone AND out of rearms: a graph reload reminted the id, so only a fresh tab
    // snapshot carries a handle the composer can use.
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-2']))
    })
    expect(hasTabsRecoveryNeedRef.current()).toBe(true)
    // An equal cached tab snapshot must leave recovery pending.
    expect(hasTabsRecoveryNeedRef.current()).toBe(true)

    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          showNativeChat: true,
          activeHandle: 'terminal-2',
          leaseReady: false,
          streamRevision: 4
        })
      )
    })
    expect(hasTabsRecoveryNeedRef.current()).toBe(false)
  })

  it('resumes a cold-start lease-only stream when WebView readiness arrives late', async () => {
    webReadyRef.current.clear()
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: false }))
    })

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledOnce()

    webReadyRef.current.add('terminal-1')
    await act(async () => {
      notifyWebReadyRef.current('terminal-1', false)
    })

    expect(unsubscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
    expect(subscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
  })
})
