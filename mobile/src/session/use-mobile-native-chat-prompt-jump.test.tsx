import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlatList } from 'react-native'
import type { NativeChatMessage, NativeChatRole } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatPromptJump } from './use-mobile-native-chat-prompt-jump'

function transcript(...roles: NativeChatRole[]): NativeChatMessage[] {
  return roles.map((role, index) => ({
    id: `m${index}`,
    role,
    blocks: [{ type: 'text', text: role }],
    timestamp: index,
    source: 'transcript'
  }))
}

type Jump = ReturnType<typeof useMobileNativeChatPromptJump>

function harness() {
  const list = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn() }
  const listRef = { current: list as unknown as FlatList<NativeChatMessage> }
  const seen: Jump[] = []
  function Probe({ data }: { data: NativeChatMessage[] }): ReactElement | null {
    seen.push(useMobileNativeChatPromptJump(listRef, data, true))
    return null
  }
  const latest = (): Jump => seen.at(-1)!
  return { list, seen, latest, Probe }
}

describe('useMobileNativeChatPromptJump', () => {
  let tree: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    vi.useRealTimers()
  })

  it('jumps to the newest prompt after a turn is appended', () => {
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })
    act(() => {
      tree!.update(
        createElement(Probe, { data: transcript('user', 'assistant', 'user', 'assistant') })
      )
    })

    latest().onJumpToPrompt()

    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 0, animated: true })
  })

  it('does not scroll when the loaded transcript has no prompt', () => {
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('assistant') }))
    })

    latest().onJumpToPrompt()

    expect(list.scrollToIndex).not.toHaveBeenCalled()
  })

  it('keeps one onViewableItemsChanged across renders, which FlatList requires', () => {
    const { seen, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user') }))
    })
    act(() => {
      tree!.update(createElement(Probe, { data: transcript('user', 'assistant') }))
    })

    expect(new Set(seen.map((jump) => jump.onViewableItemsChanged)).size).toBe(1)
  })

  it('lands near an unmeasured row, then retries the exact jump', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })

    latest().onScrollToIndexFailed({
      index: 5,
      highestMeasuredFrameIndex: 2,
      averageItemLength: 100
    })
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 500, animated: true })
    expect(list.scrollToIndex).not.toHaveBeenCalled()

    vi.advanceTimersByTime(120)
    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 5, viewPosition: 0, animated: true })
  })

  it('drops a pending retry when the view unmounts', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })

    latest().onScrollToIndexFailed({
      index: 5,
      highestMeasuredFrameIndex: 2,
      averageItemLength: 100
    })
    act(() => tree!.unmount())
    tree = null
    vi.advanceTimersByTime(120)

    expect(list.scrollToIndex).not.toHaveBeenCalled()
  })
})
