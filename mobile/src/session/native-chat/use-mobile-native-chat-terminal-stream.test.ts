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
      subscribe,
      unsubscribe
    })
    notifyWebReadyRef.current = stream.notifyWebReady
    notifyListedHandlesRef.current = stream.notifyListedHandles
    hasTabsRecoveryNeedRef.current = stream.hasTabsRecoveryNeed
    return null
  }

  // Model subscribed then end in one dead-PTY round trip; testing end alone misses a self-refilling rearm loop.
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

    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: false }))
    })

    expect(unsubscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
    expect(subscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
  })

  // A synchronous tab switch still sees old chat coverage and opens the incoming terminal as lease-only.
  function handOffToTerminalTwo(): void {
    subscribeOpensLeaseOnly = true
    subscribe('terminal-2')
    subscribeOpensLeaseOnly = false
    subscribe.mockClear()
    unsubscribe.mockClear()
  }

  it('trades a lease-only stream for output when a chat tab hands off to a terminal tab', async () => {
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

    expect(unsubscribe).toHaveBeenCalledWith('terminal-2')
    expect(subscribe).toHaveBeenCalledWith('terminal-2')
    expect(leaseOnlyRef.current.has('terminal-2')).toBe(false)
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

    // A cold WebView must wait; its normal ready path skips already-live lease subscriptions.
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
    subscriptionsRef.current.delete('terminal-1')
    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: true, leaseReady: false }))
    })

    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith('terminal-1')
    // Require rearm specifically: resume would also subscribe but lose coverage.
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('stops rearming a handle whose stream never comes back (#10681)', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()
    // Dead PTYs answer subscribed/end repeatedly; rearm must stop rather than loop through host waits.
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
      // Locally rejected subscribes never reached the host and must not spend real attempts.
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
    await act(async () => {
      renderer?.update(
        createElement(Harness, { showNativeChat: true, leaseReady: false, streamRevision: 6 })
      )
    })
    expect(subscribe).not.toHaveBeenCalled()

    // Still-listed dead handles must not refill on every inventory refresh.
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-1']))
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })
    expect(subscribe).not.toHaveBeenCalled()

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
    // End without subscribed leaves lease state unchanged; the revision signal must trigger recovery.
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
    // Subscribed is only half a dead-PTY reply; clearing attempts there would refill the loop forever.
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
    // Preserve absence markers until exhaustion actually consumes them; early consumption can permanently lock a still-listed handle.
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
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-1']))
    })
    expect(hasTabsRecoveryNeedRef.current()).toBe(false)

    // Exhaustion plus absence needs a fresh tab snapshot to find the reminted handle.
    await act(async () => {
      notifyListedHandlesRef.current(new Set(['terminal-2']))
    })
    expect(hasTabsRecoveryNeedRef.current()).toBe(true)
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
