import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  list,
  render,
  scrollToOffset,
  update
} from './MobileNativeChatView.harness.test-fixture'

const diagram = vi.hoisted(() => ({ pending: false }))

vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  const React = await import('react')
  const { useMobileTranscriptLayoutPending } =
    await import('../components/mobile-transcript-layout')
  const stub = await reactNativeStub()
  function Diagram() {
    useMobileTranscriptLayoutPending(diagram.pending)
    return null
  }
  return {
    ...stub,
    FlatList: React.forwardRef((props, ref) =>
      React.createElement(stub.FlatList, { ...props, ref }, React.createElement(Diagram))
    )
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('./MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: initial measured position', () => {
  installChatViewHooks()
  afterEach(() => {
    vi.useRealTimers()
    diagram.pending = false
  })

  function measured(height: number, offset: number) {
    return {
      contentOffset: { y: offset },
      contentSize: { height },
      layoutMeasurement: { height: 500 }
    }
  }
  const transcript = { folded: [assistantTurn('a', 'A long response')] }

  it('ignores a delayed content-size callback from the previously opened tab', async () => {
    await render(transcript)
    const previousResize = list().props.onContentSizeChange
    await update({ ...transcript, sendSurfaceId: 'another-tab' })
    scrollToOffset.mockClear()
    act(() => previousResize(320, 9000))
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('waits for a diagram to finish sizing before revealing an otherwise settled bottom', async () => {
    vi.useFakeTimers()
    diagram.pending = true
    await render(transcript)
    act(() => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 400)
    })
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(list().props.style).toMatchObject({ opacity: 0 })
    diagram.pending = false
    await update(transcript)
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
  })

  it('does not leave retained text hidden indefinitely behind a slow diagram', async () => {
    vi.useFakeTimers()
    diagram.pending = true
    await render({ ...transcript, messages: transcript.folded })
    act(() => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 1200)
      list().props.onScroll({ nativeEvent: measured(1200, 700) })
    })
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
  })

  it('reveals a continuously growing transcript instead of waiting forever for a quiet frame', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16)
    )
    await render({ ...transcript, messages: transcript.folded })
    act(() => list().props.onLayout({ nativeEvent: { layout: { height: 500 } } }))
    for (let tick = 0; tick < 70; tick++) {
      act(() => list().props.onContentSizeChange(320, 1200 + tick))
      await act(async () => {
        vi.advanceTimersByTime(16)
      })
    }
    expect(list().props.style).toBeUndefined()
  })

  it('starts virtualization at the newest row so estimated offscreen spacers cannot masquerade as the bottom', async () => {
    const folded = Array.from({ length: 80 }, (_, index) => assistantTurn(`a-${index}`, 'Response'))
    await render({ folded })
    expect(list().props.initialScrollIndex).toBe(70)
    expect(list().props.initialNumToRender).toBe(10)
    expect(list().props.onScrollToIndexFailed).toEqual(expect.any(Function))
    await update({
      folded: [
        ...Array.from({ length: 20 }, (_, index) => assistantTurn(`old-${index}`, 'Earlier')),
        ...folded
      ]
    })
    expect(list().props.initialScrollIndex).toBe(70)
    await update({ ...transcript, sendSurfaceId: 'small-chat' })
    expect(list().props.initialScrollIndex).toBe(0)
  })

  it('reveals a measured and pinned transcript without waiting for another native acknowledgement', async () => {
    vi.useFakeTimers()
    await render(transcript)
    act(() => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 1200)
      list().props.onScroll({ nativeEvent: measured(800, 300) })
    })
    scrollToOffset.mockClear()
    await act(async () => {
      vi.runAllTimers()
    })
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 1200 })
    expect(list().props.style).toBeUndefined()
    act(() => list().props.onScroll({ nativeEvent: measured(1200, 700) }))
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
  })

  it('waits for quiet layout before revealing and restarts when Markdown changes height', async () => {
    vi.useFakeTimers()
    await render(transcript)
    act(() => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 1200)
    })
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(list().props.style).toMatchObject({ opacity: 0 })
    act(() => list().props.onContentSizeChange(320, 1400))
    expect(list().props.style).toMatchObject({ opacity: 0 })
    await act(async () => {
      vi.advanceTimersByTime(199)
    })
    expect(list().props.style).toMatchObject({ opacity: 0 })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1400 })
    expect(list().props.style).toBeUndefined()
  })

  it('resets on tab revisits and reveals a short transcript without needing a scroll event', async () => {
    vi.useFakeTimers()
    await render(transcript)
    const layout = () => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 400)
    }
    act(layout)
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
    await update({ ...transcript, sendSurfaceId: 'tab-b' })
    expect(list().props.style).toMatchObject({ opacity: 0 })
    act(layout)
    await act(async () => {
      vi.runAllTimers()
    })
    await update(transcript)
    expect(list().props.style).toMatchObject({ opacity: 0 })
    act(layout)
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
  })

  it('reveals retained long history after returning to a tab even if native emits no new scroll event', async () => {
    vi.useFakeTimers()
    const retained = { ...transcript, messages: transcript.folded }
    await render(retained)
    const layout = () => {
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 1200)
    }
    act(() => {
      layout()
      list().props.onScroll({ nativeEvent: measured(1200, 700) })
    })
    await act(async () => {
      vi.runAllTimers()
    })
    await update({ ...retained, sendSurfaceId: 'tab-b' })
    act(() => {
      layout()
      list().props.onScroll({ nativeEvent: measured(1200, 700) })
    })
    await act(async () => {
      vi.runAllTimers()
    })
    await update(retained)
    act(layout)
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(list().props.data.length).toBeGreaterThan(0)
    expect(list().props.style).toBeUndefined()
  })

  it('accepts a native scroll acknowledgement that arrives before content layout', async () => {
    vi.useFakeTimers()
    await render(transcript)
    act(() => {
      list().props.onScroll({ nativeEvent: measured(1200, 700) })
      list().props.onLayout({ nativeEvent: { layout: { height: 500 } } })
      list().props.onContentSizeChange(320, 1200)
    })
    await act(async () => {
      vi.runAllTimers()
    })
    expect(list().props.style).toBeUndefined()
  })
})
