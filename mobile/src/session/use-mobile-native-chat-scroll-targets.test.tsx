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
  it('resolves a press against the transcript as of the last render, not the previous one', () => {
    // Regression: the ref that backs the press-time lookup used to update in a
    // passive effect, which can be deferred past the paint. A press landing in
    // that window resolved against the old transcript and jumped to an older
    // prompt. The lookup must see the appended turn that is already on screen.
    const scrollToIndex = vi.fn()
    const listRef = { current: { scrollToIndex } }
    const { captured, Probe } = probe(listRef)

    let tree: ReturnType<typeof create>
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })
    act(() => {
      // A second turn streams in: user2 / assistant3.
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
