import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTailFollow,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

const platform = vi.hoisted(() => ({ OS: 'web' }))
vi.mock('react-native', () => ({ Platform: platform }))

it('returns to a chat where the reader left it, and to the tail of one left at the tail', () => {
  let tail: MobileNativeChatTailFollow | null = null
  function Probe({ scopeKey }: { scopeKey: string }) {
    tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey })
    return null
  }
  const list = {
    scrollToEnd: vi.fn(),
    scrollToOffset: vi.fn(),
    readPlace: vi.fn(() => ({ key: 'reply-5', offset: 40 })),
    restorePlace: vi.fn(() => 'restored' as const)
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe, { scopeKey: 'chat-a' }))
  })
  act(() => tail?.pageListProps.ref(list))
  act(() => tail?.pageListProps.onEndDistance(600, true))

  act(() => renderer.update(createElement(Probe, { scopeKey: 'chat-b' })))
  expect(list.restorePlace).not.toHaveBeenCalled()
  list.scrollToEnd.mockClear()

  act(() => renderer.update(createElement(Probe, { scopeKey: 'chat-a' })))
  expect(list.restorePlace).toHaveBeenCalledWith({ key: 'reply-5', offset: 40 })
  expect(list.scrollToEnd).not.toHaveBeenCalled()
  expect(tail?.showJumpToTail).toBe(true)

  act(() => renderer.update(createElement(Probe, { scopeKey: 'chat-b' })))
  expect(list.scrollToEnd).toHaveBeenCalled()
  act(() => renderer.unmount())
})

it('keeps the place of a chat left in the middle of a native fling', () => {
  platform.OS = 'ios'
  let tail: MobileNativeChatTailFollow | null = null
  function Probe({ scopeKey }: { scopeKey: string }) {
    tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey })
    return null
  }
  const list = {
    scrollToEnd: vi.fn(),
    scrollToOffset: vi.fn(),
    readPlace: vi.fn(() => ({ key: 'reply-2', offset: 12 })),
    restorePlace: vi.fn(() => 'restored' as const)
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe, { scopeKey: 'fling-a' }))
  })
  act(() => tail?.listProps.ref(list))
  act(() => tail?.beginUserScroll())
  act(() =>
    tail?.recordScrollMetrics({
      contentOffset: { x: 0, y: 100 },
      contentSize: { width: 300, height: 3000 },
      layoutMeasurement: { width: 300, height: 600 },
      contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
      zoomScale: 1
    })
  )

  act(() => renderer.update(createElement(Probe, { scopeKey: 'fling-b' })))
  act(() => renderer.update(createElement(Probe, { scopeKey: 'fling-a' })))
  expect(list.restorePlace).toHaveBeenCalledWith({ key: 'reply-2', offset: 12 })
  act(() => renderer.unmount())
  platform.OS = 'web'
})
