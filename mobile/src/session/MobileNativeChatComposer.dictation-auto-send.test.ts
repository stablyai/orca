/**
 * The chat composer's half of "Send when dictation ends": the session's countdown sends through
 * the composer's own Send, and the user's own gestures in the composer cancel it.
 */
import { createElement, useState, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { AccessibilityInfo } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatComposerMenu } from './MobileNativeChatComposerMenu'
import {
  createMobileDictationAutoSend,
  type MobileDictationAutoSend
} from './mobile-dictation-auto-send'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FileText: 'FileText',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))

vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'BottomDrawer' }))
vi.mock('../components/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))
describe('MobileNativeChatComposer dictation auto-send', () => {
  let renderer: ReactTestRenderer | null = null
  let autoSend: MobileDictationAutoSend

  beforeEach(() => {
    vi.useFakeTimers()
    autoSend = createMobileDictationAutoSend()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  type Overrides = Partial<ComponentProps<typeof MobileNativeChatComposer>>

  function props(overrides: Overrides): ComponentProps<typeof MobileNativeChatComposer> {
    return {
      value: 'dictated words',
      onChangeText: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: () => 0,
      dictationAutoSend: autoSend,
      ...overrides
    }
  }

  async function render(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, props(overrides)))
    })
  }

  /** The composer with its draft owned by a parent, as the chat screen owns it. */
  async function renderControlled(
    onSend: Overrides['onSend'],
    initialDraft = 'dictated words',
    overrides: Overrides = {}
  ): Promise<void> {
    function ControlledComposer(): React.JSX.Element {
      const [value, setValue] = useState(initialDraft)
      return createElement(
        MobileNativeChatComposer,
        props({ ...overrides, value, onChangeText: setValue, onSend })
      )
    }
    await act(async () => {
      renderer = create(createElement(ControlledComposer))
    })
  }

  async function startCountdown(delayMs = 2000): Promise<void> {
    await act(async () => autoSend.start(delayMs))
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }

  function countdownText(): string | null {
    const rows = renderer!.root.findAllByProps({ testID: 'native-chat-dictation-auto-send' })
    return rows.length === 0
      ? null
      : rows[0]
          .findAllByType('Text')
          .map((node) => node.children.join(''))
          .join(' ')
  }

  function pressable(label: string): ReactTestInstance {
    return renderer!.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === label
    )
  }

  function field(): ReactTestInstance {
    return renderer!.root.findAllByType('TextInput')[0]
  }

  it('counts down, then sends the draft through Send', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render({ onSend })
    await startCountdown()

    expect(countdownText()).toBe('Sending in 2s Cancel')
    await advance(1999)
    expect(onSend).not.toHaveBeenCalled()

    await advance(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('dictated words')
    expect(countdownText()).toBeNull()
  })

  it.each([
    ['tapping into the field', () => field().props.onFocus(), 'dictated words'],
    ['tapping Cancel', () => pressable('Cancel sending').props.onPress(), 'dictated words'],
    [
      'typing in the field',
      () => field().props.onChangeText('dictated words, edited'),
      'dictated words, edited'
    ]
  ])('keeps the draft after %s', async (_name, takeOver, draft) => {
    const onSend = vi.fn().mockResolvedValue(true)
    await renderControlled(onSend)
    await startCountdown()

    await act(async () => takeOver())
    await advance(2000)

    expect(onSend).not.toHaveBeenCalled()
    expect(countdownText()).toBeNull()
    expect(field().props.value).toBe(draft)
  })

  it('announces the countdown and how to cancel it once, not every second', async () => {
    vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear()
    await render()
    const liveRegion = renderer!.root.findByProps({
      testID: 'native-chat-dictation-auto-send-announcement'
    })
    expect(liveRegion.props.accessibilityLiveRegion).toBe('polite')
    expect(liveRegion.props.children).toBe('')

    await startCountdown(3000)
    await advance(2000)

    const announcement = 'Sending message in 3 seconds. Tap Cancel to keep it as a draft.'
    expect(liveRegion.props.children).toBe(announcement)
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledTimes(1)
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      announcement,
      { queue: false }
    )
  })

  it('sends once when the user taps Send during the countdown', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render({ onSend })
    await startCountdown()

    await act(async () => pressable('Send message').props.onPress())
    await advance(2000)

    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('stops when the chat surface changes', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render({ onSend })
    await startCountdown()

    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, props({ onSend, sendSurfaceId: 'tab-b' }))
      )
    })
    await advance(2000)

    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends nothing once the composer is gone', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render({ onSend })
    act(() => renderer?.unmount())
    renderer = null

    await startCountdown()
    await advance(2000)

    expect(onSend).not.toHaveBeenCalled()
  })

  // The transcript is still on its way from the desktop: the dictation is armed, not counting yet.
  it.each([
    ['typing in the field', () => field().props.onChangeText('a correction'), 0],
    ['tapping into the field', () => field().props.onFocus(), 0],
    ['tapping Send', () => pressable('Send message').props.onPress(), 1]
  ])('does not count down a late transcript after %s', async (_name, takeOver, sends) => {
    const onSend = vi.fn().mockResolvedValue(true)
    await renderControlled(onSend)
    act(() => autoSend.arm())

    await act(async () => takeOver())
    await act(async () => autoSend.startIfArmed(2000))
    await advance(2000)

    expect(countdownText()).toBeNull()
    expect(onSend).toHaveBeenCalledTimes(sends)
  })

  it('does not count down a late transcript after a file suggestion is picked', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await renderControlled(onSend, '@src', { filePaths: ['src/app.ts'] })
    act(() => autoSend.arm())

    await act(async () =>
      field().props.onSelectionChange({ nativeEvent: { selection: { start: 4, end: 4 } } })
    )
    const menu = renderer!.root.findByType(MobileNativeChatComposerMenu)
    await act(async () => menu.props.onPick(menu.props.rows[0]))
    await act(async () => autoSend.startIfArmed(2000))
    await advance(2000)

    expect(field().props.value).toContain('src/app.ts')
    expect(countdownText()).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not count down a late transcript after the composer went away', async () => {
    await render()
    act(() => autoSend.arm())
    act(() => renderer?.unmount())
    renderer = null

    act(() => autoSend.startIfArmed(2000))

    expect(autoSend.getSnapshot()).toBeNull()
  })
})
