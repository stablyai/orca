import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileNativeChatItemNavigation } from './use-mobile-native-chat-item-navigation'
import { useMobileNativeChatTailFollow } from './use-mobile-native-chat-tail-follow'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

it('keeps a parked reader and follow intent when a linked item is absent', () => {
  let position = -400
  let result: string | undefined
  let tail: ReturnType<typeof useMobileNativeChatTailFollow> | undefined
  const target = { sessionId: 'chat', itemId: 'missing' }
  function View({ linked }: { linked: boolean }) {
    tail = useMobileNativeChatTailFollow({ hasItems: true, scopeKey: 'chat' })
    tail.pageListProps.ref({
      scrollToEnd: () => {
        position = 0
      },
      scrollToOffset: ({ offset }) => {
        position = offset
      }
    })
    useMobileNativeChatItemNavigation({
      navigation: linked
        ? {
            target,
            complete: (outcome) => {
              result = outcome
            }
          }
        : null,
      rows: [],
      rowKeys: {
        scope: 'chat',
        sourceHead: undefined,
        keyOf: (row) => row.id,
        current: () => undefined,
        placement: (key) => key
      },
      ready: true,
      hasMore: false,
      olderPages: 'idle',
      loadEarlier: () => {},
      tail
    })
    return null
  }
  let tree: ReturnType<typeof create> | undefined
  try {
    act(() => {
      tree = create(createElement(View, { linked: false }))
    })
    act(() => tail?.pageListProps.onEndDistance(400, true))
    act(() => tree?.update(createElement(View, { linked: true })))
    expect(result).toBe('missing')
    expect(position).toBe(-400)
    expect(tail?.pageListProps.isFollowing()).toBe(false)
  } finally {
    act(() => tree?.unmount())
  }
})
