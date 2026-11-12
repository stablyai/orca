// @vitest-environment happy-dom
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

import { createElement, type ReactElement } from 'react'

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import type { ActionSheetAction } from '../../../components/ActionSheetModal'
import { MobileNativeChatQueueAbovePromptContext } from '../mobile-native-chat-lower-region-context'

let fontScale = 1
vi.mock('../../../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => useRef({ value }).current
  }
})

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale, width: 390 }),
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Image: 'Image',
  AlertCircle: 'AlertCircle',
  ArrowUpRight: 'ArrowUpRight',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2',
  X: 'X'
}))

vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatBackgroundTasks', () => ({
  MobileNativeChatBackgroundTasks: 'BackgroundTasks'
}))
vi.mock('./MobileNativeChatDockedTaskList', () => ({
  MobileNativeChatDockedTaskList: 'DockedTaskList'
}))

vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

function card(
  overrides: Partial<MobileQueuedMessageCard> & { messageId: string }
): MobileQueuedMessageCard {
  const text = overrides.text ?? `text of ${overrides.messageId}`
  return {
    position: 1,
    text,
    line: text,
    state: 'waiting',
    hold: overrides.state === 'returned' ? 'returned' : 'turn',
    needsAttention: false,
    caption: null,
    ...overrides
  }
}

describe('MobileNativeChatQueuedMessages', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    act(() => renderer?.unmount())
    renderer = null
    await activateMobileUiLocale('en')
  })

  type Props = Parameters<typeof MobileNativeChatQueuedMessages>[0]

  function element(props: Props, abovePrompt = false): ReactElement {
    return createElement(
      MobileNativeChatQueueAbovePromptContext,
      { value: abovePrompt },
      createElement(MobileNativeChatQueuedMessages, props)
    )
  }

  async function mount(props: Props, abovePrompt = false): Promise<ReactTestRenderer> {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(element(props, abovePrompt))
    })
    return mounted
  }

  function rows(mounted: ReactTestRenderer) {
    return mounted.root.findAll(
      (node) => typeof node.type === 'string' && node.props.testID === 'queued-card-row'
    )
  }

  function foldToggle(mounted: ReactTestRenderer) {
    return mounted.root.find(
      (node) => typeof node.type === 'string' && node.props.testID === 'queued-fold-toggle'
    )
  }

  function menuAction(mounted: ReactTestRenderer, id: string) {
    const actions: ActionSheetAction[] = sheet(mounted).props.actions
    return actions.find((action) => action.id === id)
  }

  function dragList(mounted: ReactTestRenderer) {
    return mounted.root.findAll((node) => String(node.type) === 'DragReorderList')
  }

  const three = () => [card({ messageId: 'a' }), card({ messageId: 'b' }), card({ messageId: 'c' })]

  function control(mounted: ReactTestRenderer, label: string, index = 0) {
    return mounted.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label
    )[index]!
  }

  function sheet(mounted: ReactTestRenderer) {
    return mounted.root.find((node) => String(node.type) === 'ActionSheetModal')
  }

  it("closes a card's menu for good once the card leaves, even if it comes back", async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] })
    await act(async () =>
      mounted.root.findAllByProps({ accessibilityLabel: 'More actions' })[0]!.props.onPress()
    )
    expect(sheet(mounted).props.visible).toBe(true)
    await act(async () => {
      mounted.update(element({ cards: [card({ messageId: 'b' })] }))
    })
    expect(sheet(mounted).props.visible).toBe(false)
    await act(async () => {
      mounted.update(element({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] }))
    })
    expect(sheet(mounted).props.visible).toBe(false)
  })

  it('runs one action per card at a time, however fast its controls are tapped', async () => {
    let answer: (done: boolean) => void = () => undefined
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({ cards: [card({ messageId: 'w' })], onSend, onDelete })
    await act(async () => control(mounted, 'More actions').props.onPress())
    // Tap all actions before disabled state renders to expose same-frame duplication.
    await act(async () => {
      control(mounted, 'Send this message').props.onPress()
      control(mounted, 'Send this message').props.onPress()
      menuAction(mounted, 'deleteMessage')!.onPress()
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
    expect(control(mounted, 'More actions').props.disabled).toBe(true)
    expect(menuAction(mounted, 'deleteMessage')!.disabled).toBe(true)
    await act(async () => answer(true))
    expect(control(mounted, 'Send this message').props.disabled).toBe(false)
  })

  it('folds to the first message above a prompt card and opens from the more row', async () => {
    const mounted = await mount({ cards: three() }, true)
    expect(rows(mounted)).toHaveLength(1)
    expect(foldToggle(mounted).props.accessibilityState).toEqual({ expanded: false })
    await act(async () => foldToggle(mounted).props.onPress())
    expect(rows(mounted)).toHaveLength(3)
    expect(foldToggle(mounted).props.accessibilityState).toEqual({ expanded: true })
    await act(async () => foldToggle(mounted).props.onPress())
    expect(rows(mounted)).toHaveLength(1)
  })

  it('lets the open list, not the fold row, give up height on a short screen', async () => {
    const mounted = await mount({ cards: three() }, true)
    await act(async () => foldToggle(mounted).props.onPress())
    const scroll = mounted.root.find((node) => node.type === 'ScrollView')
    // The box shrinks under a height limit; the list scrolls so Show less below it stays whole.
    expect(scroll.parent!.props.style).toMatchObject({ flexShrink: 1, minHeight: 0 })
    expect(scroll.props.style).toMatchObject({ flexShrink: 1, minHeight: 0 })
  })

  it('opens by default above the composer, and folds again when a prompt card arrives', async () => {
    const mounted = await mount({ cards: three() })
    expect(rows(mounted)).toHaveLength(3)
    await act(async () => mounted.update(element({ cards: three() }, true)))
    expect(rows(mounted)).toHaveLength(1)
  })

  it("opens a folded list for a message the person queues, not for an agent's or a delete", async () => {
    const mounted = await mount({ cards: three() }, true)
    await act(async () =>
      mounted.update(
        element(
          {
            cards: [
              ...three(),
              card({ messageId: 'x', from: { kind: 'agent', senders: [], orchestration: null } })
            ]
          },
          true
        )
      )
    )
    expect(rows(mounted)).toHaveLength(1)
    await act(async () => mounted.update(element({ cards: three().slice(0, 2) }, true)))
    expect(rows(mounted)).toHaveLength(1)
    await act(async () =>
      mounted.update(element({ cards: [...three().slice(0, 2), card({ messageId: 'd' })] }, true))
    )
    expect(rows(mounted)).toHaveLength(3)
  })

  it('opens a folded list for a failed message behind the fold, with its Send in reach', async () => {
    const foldText = (mounted: ReactTestRenderer) =>
      foldToggle(mounted)
        .findAll((node) => String(node.type) === 'Text')
        .flatMap((node) => node.props.children)
        .join('')
    const failed = (messageId: string) =>
      card({ messageId, needsAttention: true, caption: "Couldn't send" })
    const mounted = await mount(
      {
        cards: [card({ messageId: 'a' }), failed('b'), card({ messageId: 'c' })],
        agentWorking: true
      },
      true
    )
    expect(rows(mounted)).toHaveLength(3)
    // Mid-turn the others steer, but the failed card offers its retry, Send.
    const pills = mounted.root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.hitSlop !== undefined
    )
    expect(pills.map((node) => node.props.accessibilityLabel)).toEqual([
      'Submit without interrupting the model',
      'Send this message',
      'Submit without interrupting the model'
    ])
    expect(pills[1]!.props.disabled).toBe(false)
    expect(foldText(mounted)).not.toContain("Couldn't send")
    // Folding is still the person's call, and the fold row only counts.
    await act(async () => foldToggle(mounted).props.onPress())
    expect(rows(mounted)).toHaveLength(1)
    expect(foldText(mounted)).toBe('2 more')
    expect(
      foldToggle(mounted).findAll((node) => String(node.type) === 'Text')[0]!.props
        .accessibilityLabel
    ).toBe('2 more, a message needs attention')
    // An agent's new message does not reopen it for a failure the person already folded away.
    await act(async () =>
      mounted.update(
        element(
          {
            cards: [
              card({ messageId: 'a' }),
              failed('b'),
              card({ messageId: 'c' }),
              card({ messageId: 'z', from: { kind: 'agent', senders: [], orchestration: null } })
            ]
          },
          true
        )
      )
    )
    expect(rows(mounted)).toHaveLength(1)
    // A second card failing later opens it again.
    await act(async () =>
      mounted.update(element({ cards: [card({ messageId: 'a' }), failed('b'), failed('c')] }, true))
    )
    expect(rows(mounted)).toHaveLength(3)
  })

  it('keeps a folded list folded when a whole new queue replaces it', async () => {
    const mounted = await mount({ cards: three() }, true)
    await act(async () =>
      mounted.update(element({ cards: [card({ messageId: 'p' }), card({ messageId: 'q' })] }, true))
    )
    expect(rows(mounted)).toHaveLength(1)
  })

  it('leads the first row with Queued and the spoken count, but not on a returned head', async () => {
    const lead = (mounted: ReactTestRenderer) =>
      mounted.root.findAll(
        (node) => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite'
      )
    const mounted = await mount({ cards: three() })
    const [label] = lead(mounted)
    expect(label!.props.accessibilityLabel).toBe('3 queued messages')
    expect(label!.props.children).toBe('Queued')
    await act(async () => mounted.update(element({ cards: [card({ messageId: 'a' })] })))
    expect(lead(mounted)[0]!.props.accessibilityLabel).toBe('1 queued message')
    await act(async () =>
      mounted.update(
        element({ cards: [card({ messageId: 'a', state: 'returned', caption: 'Returned' })] })
      )
    )
    expect(lead(mounted).some((node) => node.props.children === 'Queued')).toBe(false)
  })

  it('keeps an expanded message open across a fold and back', async () => {
    const mounted = await mount({ cards: three() })
    const text = () =>
      mounted.root.findAll(
        (node) => typeof node.type === 'function' && node.type.name === 'MobileQueuedCardText'
      )
    await act(async () => text()[0]!.props.onToggle())
    expect(text()[0]!.props.expanded).toBe(true)
    await act(async () => foldToggle(mounted).props.onPress())
    await act(async () => foldToggle(mounted).props.onPress())
    expect(text().map((node) => node.props.expanded)).toEqual([true, false, false])
  })

  it('draws one message as a single row with no fold row', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' })] }, true)
    expect(rows(mounted)).toHaveLength(1)
    expect(mounted.root.findAll((node) => node.props.testID === 'queued-fold-toggle')).toHaveLength(
      0
    )
  })

  it('offers drag only while two or more messages are open', async () => {
    const onMove = vi.fn(async () => true)
    const one = await mount({ cards: [card({ messageId: 'a' })], onMove })
    expect(dragList(one)).toHaveLength(0)
    act(() => one.unmount())
    const folded = await mount({ cards: three(), onMove }, true)
    expect(dragList(folded)).toHaveLength(0)
    await act(async () => foldToggle(folded).props.onPress())
    expect(dragList(folded)).toHaveLength(1)
  })

  it("moves Delete into the row's menu and keeps Edit off a goal", async () => {
    const onDelete = vi.fn(async () => true)
    const onEdit = vi.fn(async () => true)
    const mounted = await mount({
      cards: [card({ messageId: 'goal', command: true }), card({ messageId: 'text' })],
      onDelete,
      onEdit
    })
    await act(async () => control(mounted, 'More actions', 0).props.onPress())
    expect(menuAction(mounted, 'editMessage')).toBeUndefined()
    await act(async () => menuAction(mounted, 'deleteMessage')!.onPress())
    expect(onDelete).toHaveBeenCalledWith('goal')
    await act(async () => control(mounted, 'More actions', 1).props.onPress())
    await act(async () => menuAction(mounted, 'editMessage')!.onPress())
    expect(onEdit).toHaveBeenCalledWith('text')
  })

  it('offers Clear all in the menu of a queue that still sends on its own', async () => {
    const onClearAll = vi.fn(async () => true)
    const mounted = await mount({ cards: three(), onClearAll, clearable: true })
    await act(async () => control(mounted, 'More actions').props.onPress())
    await act(async () => menuAction(mounted, 'clearAll')!.onPress())
    expect(onClearAll).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  describe('a paused queue', () => {
    const waiting = card({ messageId: 'waiting-1', text: 'next' })

    async function mountPaused(
      props: Partial<Parameters<typeof MobileNativeChatQueuedMessages>[0]>
    ): Promise<ReactTestRenderer> {
      return mount({
        cards: [waiting],
        onSend: vi.fn(async () => true),
        onClearAll: vi.fn(async () => true),
        ...props
      })
    }

    function resumeButton(mounted: ReactTestRenderer) {
      return control(mounted, 'Resume sending the queued messages')
    }

    it('Resume admits one press at a time and releases a lost answer for retry', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onResume })
      await act(async () => {
        resumeButton(mounted).props.onPress()
        resumeButton(mounted).props.onPress()
      })
      expect(onResume).toHaveBeenCalledOnce()
      expect(resumeButton(mounted).props.disabled).toBe(true)
      await act(async () => answer(false))
      expect(resumeButton(mounted).props.disabled).toBe(false)
      await act(async () => resumeButton(mounted).props.onPress())
      expect(onResume).toHaveBeenCalledTimes(2)
    })
  })
})
