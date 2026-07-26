import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatTerminalStream } from './use-mobile-native-chat-terminal-stream'

describe('useMobileNativeChatTerminalStream', () => {
  let renderer: ReactTestRenderer | null = null
  let harnessRenderCount = 0
  const subscriptionsRef = { current: new Map<string, () => void>() }
  const subscribingRef = { current: new Set<string>() }
  const webReadyRef = { current: new Set(['terminal-1']) }
  const initializedRef = { current: new Set(['terminal-1']) }
  const subscribe = vi.fn((handle: string) => subscriptionsRef.current.set(handle, () => {}))
  const unsubscribe = vi.fn((handle: string) => subscriptionsRef.current.delete(handle))
  const notifyWebReadyRef = { current: (_handle: string, _wasAlreadyReady: boolean): void => {} }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
  })

  function Harness({ showNativeChat }: { showNativeChat: boolean }): null {
    harnessRenderCount += 1
    notifyWebReadyRef.current = useMobileNativeChatTerminalStream({
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
        notifyWebReadyRef.current('terminal-1', false)
      })

      expect(unsubscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
      expect(subscribe).toHaveBeenNthCalledWith(2, 'terminal-1')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
