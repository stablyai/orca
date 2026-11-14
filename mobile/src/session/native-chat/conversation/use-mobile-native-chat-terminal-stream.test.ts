import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatTerminalStream } from './use-mobile-native-chat-terminal-stream'

describe('useMobileNativeChatTerminalStream', () => {
  let renderer: ReactTestRenderer | null = null
  const subscriptionsRef = { current: new Map<string, () => void>() }
  const subscribingRef = { current: new Set<string>() }
  const leaseOnlyRef = { current: new Set<string>() }
  const webReadyRef = { current: new Set(['terminal-1']) }
  const registerSubscription = (handle: string): boolean => {
    subscriptionsRef.current.set(handle, () => {})
    leaseOnlyRef.current.delete(handle)
    return true
  }
  const subscribe = vi.fn(registerSubscription)
  const unsubscribe = vi.fn((handle: string) => {
    subscriptionsRef.current.delete(handle)
    leaseOnlyRef.current.delete(handle)
  })
  const notifyListedHandlesRef = { current: (_liveHandles: ReadonlySet<string>): void => {} }
  const hasTabsRecoveryNeedRef = { current: (): boolean => false }

  beforeEach(() => {
    subscriptionsRef.current = new Map([['terminal-1', () => {}]])
    subscribingRef.current = new Set()
    leaseOnlyRef.current = new Set()
    webReadyRef.current = new Set(['terminal-1'])
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
})
