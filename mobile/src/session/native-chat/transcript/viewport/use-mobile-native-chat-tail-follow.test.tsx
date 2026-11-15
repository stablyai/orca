import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTailFollow,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

it('keeps a reply scrolled to its start when new output grows the chat', () => {
  let tail: MobileNativeChatTailFollow | null = null
  function Probe() {
    tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey: 'chat' })
    return null
  }
  const list = { scrollToEnd: vi.fn(), scrollToOffset: vi.fn(), scrollToIndex: vi.fn() }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe))
  })
  act(() => tail?.listProps.ref(list))

  act(() => tail?.scrollRowToTop({ index: 3, viewOffset: 40 }))
  act(() => tail?.pinToTailAfterContentResize(0, 900))

  expect(list.scrollToIndex).toHaveBeenCalledWith({
    animated: true,
    index: 3,
    viewPosition: 0,
    viewOffset: 40
  })
  expect(list.scrollToOffset).not.toHaveBeenCalled()
  act(() => renderer.unmount())
})
