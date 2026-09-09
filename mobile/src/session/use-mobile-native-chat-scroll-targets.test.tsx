import { createElement, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { FlatList } from 'react-native'
import type { NativeChatMessage, NativeChatRole } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatScrollTargets } from './use-mobile-native-chat-scroll-targets'

function transcript(...roles: NativeChatRole[]): NativeChatMessage[] {
  return roles.map((role, index) => ({
    id: `m${index}`,
    role,
    blocks: [{ type: 'text', text: role }],
    timestamp: index,
    source: 'transcript'
  }))
}

/** Renders the hook and hands its callbacks back, so a test can press without a UI. */
function probe(listRef: { current: unknown }) {
  const captured: { onScrollToPrompt?: (index: number) => void } = {}
  function Probe({ data }: { data: NativeChatMessage[] }): ReactElement | null {
    const targets = useMobileNativeChatScrollTargets(
      listRef as { current: FlatList<NativeChatMessage> | null },
      data
    )
    captured.onScrollToPrompt = targets.onScrollToPrompt
    return null
  }
  return { captured, Probe }
}

describe('useMobileNativeChatScrollTargets', () => {
  it('anchors to the newest prompt after a turn is appended, not the previous one', () => {
    // The press-time lookup reads the transcript through a ref rather than
    // closing over it, so this asserts the ref actually tracks re-renders: after
    // a second turn is appended, pressing on the new answer must resolve to the
    // new prompt (index 2), not the first one.
    //
    // ⚠️ This does *not* regress the `useEffect` → `useLayoutEffect` change in the
    // hook. `act` flushes passive effects before returning, and an update issued
    // inside `act` has not rendered yet, so the pre-paint window a real press can
    // land in is not reachable from this harness — verified by flipping the hook
    // back to `useEffect`, which leaves this test green. The layout effect is
    // still correct; it just is not what this test proves.
    const scrollToIndex = vi.fn()
    const listRef = { current: { scrollToIndex } }
    const { captured, Probe } = probe(listRef)

    let tree: ReturnType<typeof create>
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })
    act(() => {
      // A second turn streams in: user2 / assistant3. The press happens *inside*
      // the act callback, after the commit but before `act` flushes passive
      // effects — that is exactly the window a real press can land in.
      tree.update(
        createElement(Probe, { data: transcript('user', 'assistant', 'user', 'assistant') })
      )
    })

    captured.onScrollToPrompt?.(3)

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 0, animated: true })
  })

  it('falls back to the head of the transcript when no prompt precedes the row', () => {
    const scrollToIndex = vi.fn()
    const listRef = { current: { scrollToIndex } }
    const { captured, Probe } = probe(listRef)

    act(() => {
      create(createElement(Probe, { data: transcript('assistant', 'assistant') }))
    })
    captured.onScrollToPrompt?.(1)

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, viewPosition: 0, animated: true })
  })
})
