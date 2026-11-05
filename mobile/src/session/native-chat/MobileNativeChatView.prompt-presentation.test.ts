import './MobileNativeChatView.harness.test-fixture'
import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Pressable } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatView } from './MobileNativeChatView'
import { useMobileNativeChatPromptPresentation } from './input/use-mobile-native-chat-prompt-presentation'
import type { MobileChatPermission } from './input/mobile-native-chat-permission'
import { setMobileNativeChatDraftText } from './composer/mobile-native-chat-draft-store'
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ...(await import('../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
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
      'ListEnd',
      'CornerDownRight',
      'ChevronDown',
      'ChevronUp',
      'ChevronsDownUp',
      'ChevronsUpDown',
      'ShieldQuestion',
      'ImagePlus',
      'Package',
      'Plus',
      'Mic',
      'Square',
      'X'
    ].map((x) => [x, x])
  )
)
vi.mock('./transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('./transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('./input/MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: 'SessionOptions'
}))
vi.mock('./composer/MobileNativeChatComposerMenu', () => ({
  MobileNativeChatComposerMenu: 'Suggestions'
}))
vi.mock('../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../../composer-usage/ComposerUsageMeter', () => ({ ComposerUsageSlot: () => null }))
vi.mock('../../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
let tree: ReactTestRenderer | null = null
setMobileNativeChatDraftText('terminal-1', 'no, do X instead')
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
  draftKey: 'terminal-1',
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
    waitStartedAt: overrides.waitStartedAt ?? 10,
    scopeKey: 'tab-1',
    sessionKey: overrides.sessionKey ?? 'session-1',
    observing: true,
    respondPermission: overrides.onRespondPermission ?? (async () => false)
  })
  return createElement(MobileNativeChatView, {
    ...props,
    ...overrides,
    permission: shown.permission,
    promptKey: shown.occurrenceKey,
    onRespondPermission: shown.respondPermission
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
})

vi.mock('../MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
