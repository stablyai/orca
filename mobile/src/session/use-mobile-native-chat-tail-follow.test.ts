import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { FlatList, NativeScrollEvent } from 'react-native'
import {
  useMobileNativeChatTailFollow,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

const scrollToOffset = vi.fn()
const scrollToEnd = vi.fn()

function metrics(offsetY: number, height: number): NativeScrollEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only offset, content height, and viewport height.
  return {
    contentOffset: { x: 0, y: offsetY },
    contentSize: { width: 320, height },
    layoutMeasurement: { width: 320, height: 500 }
  } as NativeScrollEvent
}

describe('useMobileNativeChatTailFollow earlier-page anchor', () => {
  let renderer: ReactTestRenderer | null = null
  let api: MobileNativeChatTailFollow<string> | null = null

  function Harness(props: {
    historyHeadId: string | null
    earlierPageLoading: boolean
    surfaceKey: string
    messageIds: readonly string[]
  }) {
    api = useMobileNativeChatTailFollow<string>({
      hasItems: true,
      historyHeadId: props.historyHeadId,
      messageIds: props.messageIds,
      earlierPageLoading: props.earlierPageLoading,
      surfaceKey: props.surfaceKey
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only scrollToOffset and scrollToEnd on this ref.
    api.listRef.current = { scrollToOffset, scrollToEnd } as unknown as FlatList<string>
    return null
  }

  async function render(props: {
    historyHeadId: string | null
    earlierPageLoading?: boolean
    surfaceKey?: string
    messageIds?: readonly string[]
  }): Promise<void> {
    const element = createElement(Harness, {
      historyHeadId: props.historyHeadId,
      earlierPageLoading: props.earlierPageLoading ?? false,
      surfaceKey: props.surfaceKey ?? 'tab-a',
      messageIds: props.messageIds ?? (props.historyHeadId ? [props.historyHeadId] : [])
    })
    await act(async () => {
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  async function unmount(): Promise<void> {
    act(() => renderer?.unmount())
    renderer = null
    api = null
    scrollToOffset.mockReset()
    scrollToEnd.mockReset()
  }

  it('uses the offset the reader scrolled to while the page was loading', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
      api!.recordScrollMetrics(metrics(80, 400))
    })
    await render({ historyHeadId: 'a0', earlierPageLoading: true, messageIds: ['a0', 'a1'] })
    act(() => api!.pinToTailAfterContentResize(320, 900))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 580 })
    await unmount()
  })

  it('keeps the anchor when a streaming chunk arrives before the page', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
      api!.pinToTailAfterContentResize(320, 480)
    })
    expect(scrollToOffset).not.toHaveBeenCalled()

    await render({ historyHeadId: 'a0', earlierPageLoading: true, messageIds: ['a0', 'a1'] })
    act(() => api!.pinToTailAfterContentResize(320, 900))
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 440 })
    await unmount()
  })

  it('still compensates when the insert and the loading flag settle together', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
    })
    await render({ historyHeadId: 'a0', earlierPageLoading: false, messageIds: ['a0', 'a1'] })
    act(() => api!.pinToTailAfterContentResize(320, 900))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 520 })
    await unmount()
  })

  it('does not apply a stale anchor after the page finishes without older rows', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
    })
    await render({ historyHeadId: 'a1', earlierPageLoading: false })
    act(() => api!.pinToTailAfterContentResize(320, 700))

    expect(scrollToOffset).not.toHaveBeenCalled()
    await unmount()
  })

  it('does not apply the previous chat anchor after a surface switch', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true, surfaceKey: 'tab-a' })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
    })
    await render({ historyHeadId: 'b0', earlierPageLoading: false, surfaceKey: 'tab-b' })
    act(() => api!.pinToTailAfterContentResize(320, 900))

    expect(scrollToOffset).not.toHaveBeenCalled()
    await unmount()
  })

  it('does not shift a detached reader when a live append trims the armed row', async () => {
    await render({ historyHeadId: 'a1', earlierPageLoading: true, messageIds: ['a1', 'a2'] })
    act(() => {
      api!.recordScrollMetrics(metrics(20, 400))
      api!.holdVisibleContent()
    })
    await render({ historyHeadId: 'a2', earlierPageLoading: false, messageIds: ['a2', 'a3'] })
    act(() => api!.pinToTailAfterContentResize(320, 900))

    expect(scrollToOffset).not.toHaveBeenCalled()
    await unmount()
  })
})
