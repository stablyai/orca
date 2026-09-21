import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native-gesture-handler', () => {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

// Stand-in composer: exposes the view's `handleSend` through a pressable, which is
// the only composer behaviour these banner tests exercise.
vi.mock('./MobileNativeChatComposer', async () => {
  const React = await import('react')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
    }) =>
      React.createElement('Composer', {
        ...props,
        accessibilityLabel: 'Send message',
        onPress: () => props.onSend('hi')
      })
  }
})

type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  structuredActivityUi?: boolean
  turnIndicator?: Parameters<typeof MobileNativeChatView>[0]['turnIndicator']
  agentWorking?: boolean
  canStop?: boolean
  ask?: Parameters<typeof MobileNativeChatView>[0]['ask']
  question?: Parameters<typeof MobileNativeChatView>[0]['question']
  permission?: Parameters<typeof MobileNativeChatView>[0]['permission']
  sendSurfaceId?: string
  keyboardInset?: number
  hasMore?: boolean
  onLoadEarlier?: () => void
}

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    vi.unstubAllGlobals()
  })

  async function render(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer = create(chatViewElement(overrides))
    })
  }

  async function update(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer?.update(chatViewElement(overrides))
    })
  }

  /** Ids of the rows the list is currently rendering. */
  it('keeps Stop hidden during a structured dispatch until a provider turn can be cancelled', async () => {
    const props = { structuredActivityUi: true, agentWorking: true, canStop: false }
    await render(props)
    const stops = () =>
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Stop the agent')
    expect(stops()).toHaveLength(0)
    await update({ ...props, canStop: true })
    expect(stops()).toHaveLength(1)
    await update({ agentWorking: true })
    expect(stops()).toHaveLength(1)
  })

  function listIds(): string[] {
    return (list().props.data as { id: string }[]).map((row) => row.id)
  }

  function list(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'FlatList')
  }

  function renderedRow(id: string): ReturnType<typeof createElement> {
    const listNode = list()
    const data = listNode.props.data as NativeChatMessage[]
    const index = data.findIndex((row) => row.id === id)
    return listNode.props.renderItem({ item: data[index], index })
  }

  function banners(): ReactTestInstance[] {
    return renderer!.root.findAll((node) => node.props.accessibilityRole === 'alert')
  }

  function composer(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'Composer')
  }

  function bannerText(): string {
    const [alert, ...rest] = banners()
    expect(rest).toHaveLength(0)
    return alert
      .findAll((node) => node.type === 'Text')
      .map((node) => node.props.children)
      .join('')
  }

  async function pressSend(): Promise<void> {
    const composer = renderer!.root.find((node) => node.type === 'Composer') as {
      props: { onPress: () => Promise<boolean> }
    }
    await act(async () => {
      await composer.props.onPress()
    })
  }

  async function scrollAwayFromTail(): Promise<void> {
    await act(async () => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
    })
  }

  it('renders the route-reported failure verbatim', async () => {
    await render({ sendErrorMessage: 'Permission reply failed' })

    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Permission reply failed')
  })

  it('does not duplicate the route banner when the composer rejects', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).not.toHaveBeenCalled()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Stop failed')
    expect(bannerText()).toBe('Stop failed')
  })

  it('retires the route-owned banner once a send is accepted', async () => {
    const onClearSendError = vi.fn()
    await render({ sendErrorMessage: 'Stop failed', onClearSendError })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
  })

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('lets content growth own streaming tail-follow without a delayed animated command', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Starting')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, streaming: 'Streaming output' })
      act(() => list().props.onContentSizeChange(320, 900))

      expect(scrollToOffset).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToOffset).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops tail-follow before loading earlier history can resize the list', async () => {
    const folded = [assistantTurn('a1', 'History')]
    const onLoadEarlier = vi.fn()
    await render({ folded, hasMore: true, onLoadEarlier })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 40 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 950)
    })

    expect(onLoadEarlier).toHaveBeenCalledOnce()
    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('does not treat programmatic scroll metrics as user intent', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 1_300)
    })

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
    expect(
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(0)
  })

  it('keeps tail-follow paused across the drag-to-momentum handoff', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => list().props.onScrollBeginDrag?.({}))
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)

      act(() => {
        list().props.onScroll({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_250)
        list().props.onMomentumScrollBegin?.({})
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_300))

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      act(() => {
        list().props.onMomentumScrollEnd?.({
          nativeEvent: {
            contentOffset: { y: 800 },
            contentSize: { height: 1_300 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_350)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_350 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses momentum-end metrics instead of a stale throttled scroll sample', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 700 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onScrollEndDrag?.({
        nativeEvent: {
          contentOffset: { y: 700 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onMomentumScrollBegin?.({})
      list().props.onMomentumScrollEnd?.({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_300 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 1_350)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(1)
  })

  it('uses finger-release metrics when no momentum event follows', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll({
          nativeEvent: {
            contentOffset: { y: 200 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 620 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_250))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_250 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('repins when content grows between tail release and drag settle', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_250)
      })

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      await act(async () => {
        vi.runOnlyPendingTimers()
      })

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses measured content height when the first message fills an empty transcript', async () => {
    await render()

    await pressSend()
    expect(scrollToEnd).not.toHaveBeenCalled()

    await update({ folded: [assistantTurn('a1', 'First response')] })
    act(() => list().props.onContentSizeChange(320, 1_200))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_200 })
  })

  it('keeps a history load detached after its triggering drag settles', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Short history')]
      const onLoadEarlier = vi.fn()
      await render({ folded, hasMore: true, onLoadEarlier })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll({
          nativeEvent: {
            contentOffset: { y: 0 },
            contentSize: { height: 400 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 0 },
            contentSize: { height: 400 },
            layoutMeasurement: { height: 500 }
          }
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 950))

      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes an accepted send through the immediate nonanimated tail owner', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'History')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      await scrollAwayFromTail()
      scrollToEnd.mockClear()

      await pressSend()

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes the latest-message chevron through the tail owner and resumes following', async () => {
    const folded = [assistantTurn('a1', 'History')]
    await render({ folded })
    await scrollAwayFromTail()
    scrollToEnd.mockClear()

    const chevron = renderer!.root.find(
      (node) => node.props.accessibilityLabel === 'Scroll to latest'
    )
    act(() => chevron.props.onPress())
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })

    act(() => list().props.onContentSizeChange(320, 1_300))
    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
  })

  it('repins after a keyboard-driven viewport layout only while following', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, keyboardInset: 320 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 400 } } }))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()

      await scrollAwayFromTail()
      scrollToEnd.mockClear()
      await update({ folded, keyboardInset: 0 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 700 } } }))
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders an accepted optimistic image send without a queued state', async () => {
    await render({
      pending: [{ id: 'pending-1', text: 'look', images: ['file:///phone-photo.jpg'] }]
    })

    expect(listIds()).toEqual(['pending-1'])
    expect(renderedRow('pending-1').props).not.toHaveProperty('queued')
  })

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await update({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      expect(composer().props.disabled).toBe(true)
      expect(composer().props.placeholder).toBe('Waiting for terminal…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks after the lease stays ready', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      await update({ inputLockReason: null })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(composer().props.disabled).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
    } finally {
      vi.useRealTimers()
    }
  })

  describe('structured turn status wiring', () => {
    const userTurn = (id: string, text: string): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 0,
      source: 'transcript'
    })

    function rowProps(id: string): Record<string, unknown> {
      return (renderedRow(id) as { props: Record<string, unknown> }).props
    }

    function footerProps(): Record<string, unknown> | null {
      const list = renderer!.root.find((node) => node.type === 'FlatList')
      const footer = list.props.ListFooterComponent as
        | { props: Record<string, unknown> }
        | null
        | undefined
      return footer?.props ?? null
    }

    function workingIndicators(): ReactTestInstance[] {
      return renderer!.root.findAll((node) => node.type === 'WorkingIndicator')
    }

    it('puts the live status at the turn tail and drops the three-dot indicator', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'still working')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      const props = rowProps('u1')
      expect(props.structuredActivityUi).toBe(true)
      expect(props.turnStatus).toBeNull()
      // Nothing reports reasoning, so the one live footer counts instead of guessing.
      expect(footerProps()).toMatchObject({ thinking: false, workedSeconds: null })
      expect(listIds().at(-1)).toBe('a1')
      expect(props.activeTurnIsWorking).toBe(true)
      expect(workingIndicators()).toHaveLength(0)
    })

    it.each([
      {
        label: 'structured question',
        cardType: 'ChatAsk',
        interaction: {
          ask: {
            questions: [
              {
                question: 'Pick destination',
                multiSelect: false,
                options: [{ label: 'Choice A' }, { label: 'Choice B' }]
              }
            ]
          }
        }
      },
      {
        label: 'question',
        cardType: 'ChatQuestion',
        interaction: {
          question: {
            question: 'Pick destination',
            options: ['Choice A', 'Choice B'],
            multiSelect: false,
            allowOther: true,
            optionTokens: ['choice-a', 'choice-b']
          }
        }
      },
      {
        label: 'approval',
        cardType: 'ChatPermission',
        interaction: {
          permission: {
            title: 'Allow command?',
            detail: 'pnpm test',
            options: [
              { label: 'Allow', send: 'allow' },
              { label: 'Deny', send: 'deny' }
            ]
          }
        }
      }
    ])('hides live turn activity for a pending $label without settling it', async (testCase) => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'waiting for input')]
      const working = {
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        canStop: true
      }
      await render({ ...working, ...testCase.interaction })

      expect(footerProps()).toBeNull()
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Stop the agent')
      ).toHaveLength(1)
      expect(renderer!.root.findAll((node) => node.type === testCase.cardType)).toHaveLength(1)

      await update(working)
      expect(footerProps()).toMatchObject({ thinking: false, workedSeconds: null })
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
    })

    it('reports the live turn as thinking only when its journal says it is reasoning', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: true, activityText: null }
      })
      expect(rowProps('u1').turnStatus).toBeNull()
      expect(footerProps()).toMatchObject({ thinking: true, workedSeconds: null })
    })

    it('hands the live row the provider activity copy that outranks its fallbacks', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: true, activityText: 'Running pnpm test' }
      })
      expect(footerProps()).toMatchObject({
        thinking: true,
        activityText: 'Running pnpm test'
      })
    })

    it('keeps the activity copy on the live footer instead of a historical row', async () => {
      const folded = [userTurn('u1', 'go'), userTurn('u2', 'again')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: false, activityText: 'Running pnpm test' }
      })
      expect(rowProps('u1')).not.toHaveProperty('turnActivityText')
      expect(rowProps('u2')).not.toHaveProperty('turnActivityText')
      expect(footerProps()).toMatchObject({ activityText: 'Running pnpm test' })
    })

    it('keeps the bridge lane on the three-dot indicator with no turn status', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({ messages: folded, folded, agentWorking: true })
      const props = rowProps('u1')
      expect(props.structuredActivityUi).toBe(false)
      expect(props.turnStatus).toBeNull()
      expect(props.activeTurnIsWorking).toBe(false)
      expect(footerProps()).toBeNull()
      expect(workingIndicators()).toHaveLength(1)
    })

    it('settles the finished turn to a tappable duration', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'done')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      expect(rowProps('u1').turnStatus).toBeNull()
      expect(footerProps()).toMatchObject({ thinking: false, workedSeconds: null })
      await update({ messages: folded, folded, structuredActivityUi: true, agentWorking: false })
      const settled = rowProps('u1')
      expect(settled.turnStatus).toMatchObject({ thinking: false })
      expect((settled.turnStatus as { workedSeconds: number | null }).workedSeconds).toBeTypeOf(
        'number'
      )
      expect(settled.onToggleTurn).toBeTypeOf('function')
      expect(settled.activeTurnIsWorking).toBe(false)
      expect(footerProps()).toBeNull()
    })

    it('hangs no status row on an assistant row', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'done')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      expect(rowProps('a1').turnStatus).toBeNull()
      // The assistant row still belongs to the live turn, so its tool row stays visible.
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
      expect(footerProps()).toMatchObject({ workedSeconds: null })
    })

    it('does not carry a running turn clock across chat surfaces', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const firstTab = [userTurn('u1', 'first')]
        await render({
          messages: firstTab,
          folded: firstTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-a'
        })
        expect(footerProps()).toMatchObject({ startedAt: 1_000 })

        vi.setSystemTime(12_000)
        const secondTab = [userTurn('u2', 'second')]
        await update({
          messages: secondTab,
          folded: secondTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-b'
        })

        expect(footerProps()).toMatchObject({ startedAt: 12_000 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not treat pre-user history as part of the live turn', async () => {
      const history = [
        assistantTurn('a0', 'before the first prompt'),
        userTurn('u1', 'go'),
        assistantTurn('a1', 'working')
      ]
      await render({
        messages: history,
        folded: history,
        structuredActivityUi: true,
        agentWorking: true
      })

      expect(rowProps('a0').activeTurnIsWorking).toBe(false)
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
    })
  })
})
