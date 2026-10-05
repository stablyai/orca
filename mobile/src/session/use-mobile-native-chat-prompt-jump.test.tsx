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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook reads only the two mocked FlatList scroll methods.
  const listRef = { current: list as unknown as FlatList<NativeChatMessage> }
  const seen: Jump[] = []
  const onLeaveTail = vi.fn()
  const onReturnToTail = vi.fn()
  function Probe({
    data,
    scopeKey = 'chat-a'
  }: {
    data: NativeChatMessage[]
    scopeKey?: string
  }): ReactElement | null {
    seen.push(
      useMobileNativeChatPromptJump({
        listRef,
        data,
        loadedMessages: data,
        atBottom: true,
        onLeaveTail,
        onReturnToTail,
        scopeKey
      })
    )
    return null
  }
  const latest = (): Jump => seen.at(-1)!
  return { list, seen, latest, Probe, onLeaveTail, onReturnToTail }
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

    latest().onJumpToPrompt()
    list.scrollToIndex.mockClear()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: -1,
      averageItemLength: 100
    })
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false })
    expect(list.scrollToIndex).not.toHaveBeenCalled()

    vi.advanceTimersByTime(120)
    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 0, viewPosition: 0, animated: true })
  })

  it('drops a pending retry when the view unmounts', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })

    latest().onJumpToPrompt()
    list.scrollToIndex.mockClear()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: -1,
      averageItemLength: 100
    })
    act(() => tree!.unmount())
    tree = null
    vi.advanceTimersByTime(120)

    expect(list.scrollToIndex).not.toHaveBeenCalled()
  })

  it('keeps the same prompt when history is prepended during the retry', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    const data = transcript('user', 'assistant')
    act(() => {
      tree = create(createElement(Probe, { data }))
    })
    latest().onJumpToPrompt()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: 0,
      averageItemLength: 100
    })
    list.scrollToIndex.mockClear()

    act(() => {
      tree!.update(createElement(Probe, { data: [{ ...data[0], id: 'earlier' }, ...data] }))
    })
    vi.advanceTimersByTime(120)

    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 1, viewPosition: 0, animated: true })
  })

  it('skips the retry if its prompt disappears', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })
    latest().onJumpToPrompt()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: 0,
      averageItemLength: 100
    })
    list.scrollToIndex.mockClear()

    act(() => {
      tree!.update(createElement(Probe, { data: transcript('assistant') }))
    })
    vi.advanceTimersByTime(120)

    expect(list.scrollToIndex).not.toHaveBeenCalled()
  })
  it('keeps retrying when the first exact retry is still unmeasured', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    act(() => {
      tree = create(
        createElement(Probe, { data: transcript('user', 'assistant', 'user', 'assistant') })
      )
    })
    const failure = { index: 2, highestMeasuredFrameIndex: 0, averageItemLength: 100 }
    list.scrollToIndex.mockImplementationOnce(() => latest().onScrollToIndexFailed(failure))
    list.scrollToIndex.mockImplementationOnce(() => latest().onScrollToIndexFailed(failure))
    latest().onJumpToPrompt()
    vi.runAllTimers()
    expect(list.scrollToIndex).toHaveBeenCalledTimes(3)
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({
      index: 2,
      viewPosition: 0,
      animated: true
    })
  })

  it('bounds failed retries and restores tail-following when the target cannot be measured', () => {
    vi.useFakeTimers()
    const { list, latest, Probe, onReturnToTail } = harness()
    act(() => {
      tree = create(
        createElement(Probe, { data: transcript('user', 'assistant', 'user', 'assistant') })
      )
    })
    const failure = { index: 2, highestMeasuredFrameIndex: 0, averageItemLength: 100 }
    list.scrollToIndex.mockImplementation(() => latest().onScrollToIndexFailed(failure))
    latest().onJumpToPrompt()
    vi.runAllTimers()
    expect(list.scrollToIndex).toHaveBeenCalledTimes(5)
    expect(list.scrollToOffset).toHaveBeenCalledTimes(4)
    expect(onReturnToTail).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forgets a successful jump when its prompt becomes visible', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    const data = transcript('user', 'assistant', 'user', 'assistant')
    act(() => {
      tree = create(createElement(Probe, { data }))
    })
    latest().onJumpToPrompt()
    act(() => {
      latest().onViewableItemsChanged({
        viewableItems: [{ key: 'm2', index: 2, item: data[2], isViewable: true }]
      })
    })
    latest().onScrollToIndexFailed({
      index: 2,
      highestMeasuredFrameIndex: 0,
      averageItemLength: 100
    })
    vi.runAllTimers()
    expect(list.scrollToIndex).toHaveBeenCalledOnce()
    expect(list.scrollToOffset).not.toHaveBeenCalled()
  })

  it('cancels later retries when the reader returns to the latest message', () => {
    vi.useFakeTimers()
    const { list, latest, Probe, onReturnToTail } = harness()
    act(() => {
      tree = create(
        createElement(Probe, { data: transcript('user', 'assistant', 'user', 'assistant') })
      )
    })
    const failure = { index: 2, highestMeasuredFrameIndex: 0, averageItemLength: 100 }
    list.scrollToIndex.mockImplementation(() => latest().onScrollToIndexFailed(failure))
    latest().onJumpToPrompt()
    vi.advanceTimersByTime(120)
    latest().onScrollToLatest()
    vi.runAllTimers()
    expect(list.scrollToIndex).toHaveBeenCalledTimes(2)
    expect(onReturnToTail).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the prompt retry when the reader chooses the latest message', () => {
    vi.useFakeTimers()
    const { list, latest, Probe, onReturnToTail } = harness()
    act(() => {
      tree = create(createElement(Probe, { data: transcript('user', 'assistant') }))
    })
    latest().onJumpToPrompt()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: -1,
      averageItemLength: 100
    })
    list.scrollToIndex.mockClear()
    latest().onScrollToLatest()
    vi.advanceTimersByTime(120)
    expect(list.scrollToIndex).not.toHaveBeenCalled()
    expect(onReturnToTail).toHaveBeenCalledOnce()
  })

  it('drops visibility and a pending retry across chat surfaces', () => {
    vi.useFakeTimers()
    const { list, latest, Probe } = harness()
    const data = transcript('user', 'assistant')
    act(() => {
      tree = create(createElement(Probe, { data }))
    })
    act(() => {
      latest().onViewableItemsChanged({ viewableItems: [] })
    })
    expect(latest().showPromptJump).toBe(true)
    latest().onJumpToPrompt()
    latest().onScrollToIndexFailed({
      index: 0,
      highestMeasuredFrameIndex: -1,
      averageItemLength: 100
    })
    list.scrollToIndex.mockClear()
    act(() => {
      tree!.update(createElement(Probe, { data, scopeKey: 'chat-b' }))
    })
    vi.advanceTimersByTime(120)
    expect(list.scrollToIndex).not.toHaveBeenCalled()
    expect(latest().showPromptJump).toBe(false)
  })
})
