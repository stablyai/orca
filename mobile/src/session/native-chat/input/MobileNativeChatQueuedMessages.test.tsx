// @vitest-environment happy-dom
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

import { createElement } from 'react'

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'

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
  useWindowDimensions: () => ({ fontScale }),
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
  ChevronRight: 'ChevronRight',
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

  async function mount(
    props: Parameters<typeof MobileNativeChatQueuedMessages>[0]
  ): Promise<ReactTestRenderer> {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(createElement(MobileNativeChatQueuedMessages, props))
    })
    return mounted
  }

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
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, { cards: [card({ messageId: 'b' })] })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [card({ messageId: 'a' }), card({ messageId: 'b' })]
        })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
  })

  it('runs one action per card at a time, however fast its controls are tapped', async () => {
    let answer: (done: boolean) => void = () => undefined
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({ cards: [card({ messageId: 'w' })], onSend, onDelete })
    // Tap all actions before disabled state renders to expose same-frame duplication.
    await act(async () => {
      control(mounted, 'Send this message').props.onPress()
      control(mounted, 'Send this message').props.onPress()
      control(mounted, 'Delete this queued message').props.onPress()
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
    expect(control(mounted, 'More actions').props.disabled).toBe(true)
    await act(async () => answer(true))
    expect(control(mounted, 'Send this message').props.disabled).toBe(false)
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
