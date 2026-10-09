import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Pressable } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatView } from './MobileNativeChatView'
import { useMobileNativeChatPromptPresentation } from './use-mobile-native-chat-prompt-presentation'
import type { MobileChatPermission } from './mobile-native-chat-permission'
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Platform: { OS: 'ios' },
    Keyboard: { dismiss: vi.fn() },
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  type GestureChain = {
    runOnJS: () => GestureChain
    onStart: () => GestureChain
    onUpdate: () => GestureChain
  }
  const chain: GestureChain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    [
      'ArrowDown',
      'ArrowUp',
      'ChevronDown',
      'ChevronUp',
      'ChevronsDownUp',
      'ChevronsUpDown',
      'ShieldQuestion',
      'ImagePlus',
      'Mic',
      'Square',
      'X'
    ].map((x) => [x, x])
  )
)
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('./MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: 'SessionOptions'
}))
vi.mock('./MobileNativeChatComposerSuggestions', () => ({
  MobileNativeChatComposerSuggestions: 'Suggestions',
  composerSuggestionInsertText: () => ''
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
let tree: ReactTestRenderer | null = null
const props = {
  messages: [],
  folded: [],
  status: 'ready' as const,
  streaming: null,
  pending: [],
  onSend: vi.fn(async () => true),
  sendSurfaceId: 'terminal-1',
  getSendCompletionGeneration: () => 0,
  getComposerEditGeneration: () => 0,
  composerText: 'no, do X instead',
  onComposerTextChange: vi.fn()
}
const permission: MobileChatPermission = {
  title: 'Claude wants to use Bash',
  options: [{ label: 'Deny', send: String.fromCharCode(27) }]
}
type Overrides = Partial<ComponentProps<typeof MobileNativeChatView>> & {
  waitStartedAt?: number
  sessionKey?: string
}
function Harness(overrides: Overrides) {
  const shown = useMobileNativeChatPromptPresentation({
    permission: overrides.permission ?? null,
    question: overrides.question ?? null,
    waitStartedAt: overrides.waitStartedAt ?? 10,
    scopeKey: 'tab-1',
    sessionKey: overrides.sessionKey ?? 'session-1',
    observing: true,
    respondPermission: overrides.onRespondPermission ?? (async () => false),
    answerQuestion: overrides.onAnswerQuestion ?? (async () => false)
  })
  return createElement(MobileNativeChatView, {
    ...props,
    ...overrides,
    permission: shown.permission,
    question: shown.question,
    promptKey: shown.occurrenceKey,
    onRespondPermission: shown.respondPermission,
    onAnswerQuestion: shown.answerQuestion
  })
}
const render = async (overrides: Overrides) => {
  await act(async () => {
    const element = createElement(Harness, overrides)
    if (tree) {
      tree.update(element)
    } else {
      tree = create(element)
    }
  })
}
const sendButton = () => tree!.root.findByProps({ accessibilityLabel: 'Send message' })
const approvalAction = () =>
  tree!.root.findByProps({ testID: 'native-chat-approval-actions' }).findByType(Pressable)
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.unstubAllGlobals()
})
describe('terminal prompt presentation with the production view, card and composer', () => {
  it('accepted Deny hides exactly that occurrence and restores Send across reconnect', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
    const onRespondPermission = vi.fn(async () => true)
    await render({ permission, onRespondPermission })
    expect(sendButton().props.disabled).toBe(true)
    await act(async () => {
      await approvalAction().props.onPress()
    })
    expect(onRespondPermission).toHaveBeenCalledExactlyOnceWith(String.fromCharCode(27))
    expect(tree!.root.findAllByProps({ testID: 'native-chat-approval-actions' })).toHaveLength(0)
    expect(sendButton().props.disabled).toBe(false)
    await render({ permission, onRespondPermission, inputLockReason: 'disconnected' })
    await render({ permission, onRespondPermission, inputLockReason: null })
    expect(sendButton().props.disabled).toBe(false)
    await render({ permission, onRespondPermission, waitStartedAt: 20 })
    expect(sendButton().props.disabled).toBe(true)
    expect(approvalAction().props.disabled).toBe(false)
  })

  it('refused or unknown answers keep the choices enabled', async () => {
    const onRespondPermission = vi.fn(async () => false)
    await render({ permission, onRespondPermission })
    await act(async () => {
      await approvalAction().props.onPress()
    })
    expect(approvalAction().props.disabled).toBe(false)
    expect(sendButton().props.disabled).toBe(true)
  })

  it('a late answer cannot reshow an answered replacement occurrence', async () => {
    let finishOld: (accepted: boolean) => void = () => {}
    const onRespondPermission = vi
      .fn<(send: string) => Promise<boolean>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve
        })
      )
      .mockResolvedValueOnce(true)
    await render({ permission, onRespondPermission })
    act(() => {
      void approvalAction().props.onPress()
    })
    await render({ permission, onRespondPermission, waitStartedAt: 20 })
    await act(async () => {
      await approvalAction().props.onPress()
    })
    expect(sendButton().props.disabled).toBe(false)
    await act(async () => finishOld(true))
    expect(sendButton().props.disabled).toBe(false)
  })

  it('a late answer cannot dismiss a replacement session', async () => {
    let finishOld: (accepted: boolean) => void = () => {}
    const onRespondPermission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishOld = resolve
        })
    )
    await render({ permission, onRespondPermission })
    act(() => {
      void approvalAction().props.onPress()
    })
    await render({ permission, onRespondPermission, sessionKey: 'session-2' })
    await act(async () => finishOld(true))
    expect(sendButton().props.disabled).toBe(true)
    expect(approvalAction().props.disabled).toBe(false)
  })

  it.each(['toggle', 'hold'])(
    'keeps %s dictation and attachments available while a prompt blocks Send',
    async (dictationMode) => {
      const onMicPress = vi.fn()
      const onMicPressOut = vi.fn()
      await render({ micActive: true, onMicPress, onMicPressOut, dictationMode })
      await render({ permission, micActive: true, onMicPress, onMicPressOut, dictationMode })
      const stop = tree!.root.findByProps({ accessibilityLabel: 'Stop dictation' })
      expect(stop.props.disabled).toBe(false)
      act(() => {
        ;(dictationMode === 'hold' ? stop.props.onPressOut : stop.props.onPress)()
      })
      expect(dictationMode === 'hold' ? onMicPressOut : onMicPress).toHaveBeenCalledOnce()
      await render({ permission, onMicPress, dictationMode, onAttachImage: vi.fn() })
      expect(tree!.root.findByProps({ accessibilityLabel: 'Dictate' }).props.disabled).toBe(false)
      expect(tree!.root.findByProps({ accessibilityLabel: 'Attach image' }).props.disabled).toBe(
        false
      )
      expect(sendButton().props.disabled).toBe(true)
    }
  )
})
