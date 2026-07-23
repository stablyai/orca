import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTerminalStream,
  type MobileNativeChatTerminalStreamController
} from './use-mobile-native-chat-terminal-stream'

const emptyController = (): MobileNativeChatTerminalStreamController => ({
  notifyWebReady: () => {},
  notifyStreamReady: () => {},
  terminateStream: () => {},
  cancelRetry: () => {},
  clearRetries: () => {}
})

describe('useMobileNativeChatTerminalStream', () => {
  let renderer: ReactTestRenderer | null = null
  let harnessRenderCount = 0
  const subscriptionsRef = { current: new Map<string, () => void>() }
  const subscribingRef = { current: new Set<string>() }
  const webReadyRef = { current: new Set(['terminal-1']) }
  const initializedRef = { current: new Set(['terminal-1']) }
  const subscribe = vi.fn((handle: string) => {
    subscriptionsRef.current.set(handle, () => {})
    return true
  })
  const unsubscribe = vi.fn((handle: string) => subscriptionsRef.current.delete(handle))
  const controllerRef = { current: emptyController() }
  let previousActEnvironment: boolean | undefined

  beforeEach(() => {
    previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    subscriptionsRef.current = new Map([['terminal-1', () => {}]])
    subscribingRef.current = new Set()
    webReadyRef.current = new Set(['terminal-1'])
    initializedRef.current = new Set(['terminal-1'])
    harnessRenderCount = 0
    subscribe.mockClear()
    unsubscribe.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  })

  function Harness({ showNativeChat }: { showNativeChat: boolean }): null {
    harnessRenderCount += 1
    controllerRef.current = useMobileNativeChatTerminalStream({
      showNativeChat,
      activeHandle: 'terminal-1',
      activeTabType: 'terminal',
      subscriptionsRef,
      subscribingRef,
      webReadyRef,
      initializedRef,
      subscribe,
      unsubscribe
    })
    return null
  }

  it('replaces output with a lease-only stream while covered, then restores output', async () => {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { showNativeChat: false }))
      })
      await act(async () => {
        controllerRef.current.notifyWebReady('terminal-1', false)
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
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('resumes a cold-start lease-only stream when WebView readiness arrives late', async () => {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
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
        controllerRef.current.notifyWebReady('terminal-1', false)
      })

      expect(unsubscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
      expect(subscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('retries a terminated covered lease until an acknowledgement resets backoff', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()

    controllerRef.current.terminateStream('terminal-1', unsubscribe)
    await act(async () => vi.advanceTimersByTimeAsync(249))
    expect(subscribe).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(subscribe).toHaveBeenCalledWith('terminal-1')

    controllerRef.current.terminateStream('terminal-1', unsubscribe)
    await act(async () => vi.advanceTimersByTimeAsync(499))
    expect(subscribe).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(subscribe).toHaveBeenCalledTimes(2)

    controllerRef.current.notifyStreamReady('terminal-1')
    controllerRef.current.terminateStream('terminal-1', unsubscribe)
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(subscribe).toHaveBeenCalledTimes(3)
  })

  it('cancels a covered retry when chat closes', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear()

    controllerRef.current.terminateStream('terminal-1', unsubscribe)
    await act(async () => {
      renderer?.update(createElement(Harness, { showNativeChat: false }))
    })
    subscribe.mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(4_000))

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('keeps backing off when a retry cannot arm a subscription yet', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { showNativeChat: true }))
    })
    subscribe.mockClear().mockReturnValueOnce(false)

    controllerRef.current.terminateStream('terminal-1', unsubscribe)
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(subscribe).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(500))

    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})
