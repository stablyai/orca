import { createElement } from 'react'
import { Pressable, Text } from 'react-native'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse, ConnectionState } from '../../transport/types'
import type { MobileNativeChatTab } from '../mobile-native-chat-eligibility'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { vi } from 'vitest'
import { useMobileNativeChatController } from '../use-mobile-native-chat-controller'
import { MobileNativeChatOverlay } from '../MobileNativeChatOverlay'
import { MobileNativeChatAsk } from '../MobileNativeChatAsk'
import type { AskAnswerSelection } from '../../../../src/shared/native-chat-ask'
import { mobileNativeChatPromptDismissals } from '../mobile-native-chat-prompt-dismissals'
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
      'X',
      'Check',
      'CircleHelp'
    ].map((x) => [x, x])
  )
)
vi.mock('../MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('../MobileNativeChatVisual', () => ({ useMobileNativeChatVisualRenderer: () => null }))
vi.mock('../MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('../MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('../MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('../MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: 'SessionOptions'
}))
vi.mock('../MobileNativeChatComposerSuggestions', () => ({
  MobileNativeChatComposerSuggestions: 'Suggestions',
  composerSuggestionInsertText: () => ''
}))
vi.mock('../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
export const visible = { value: true }
const session = { messages: [], folded: [], status: 'ready', transcriptLoading: false }
const structured = {
  session,
  isWorking: false,
  turnId: null,
  turnIndicator: null,
  workingStartedAt: null,
  settledTurns: null,
  turnJournal: null,
  permission: null,
  question: null,
  queued: { cards: [] },
  respondPermission: vi.fn(async () => true),
  respondQuestion: vi.fn(async () => true),
  cancelPrompt: vi.fn(async () => true),
  sendWithOutcome: vi.fn(async () => 'accepted'),
  cancel: vi.fn(),
  setStructuredOption: vi.fn(),
  invokeStructuredOption: vi.fn()
}
vi.mock('../use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: () => visible.value,
    toggleTabChatView: () => {
      visible.value = !visible.value
    }
  })
}))
vi.mock('../use-mobile-native-chat-session-lane', () => ({
  useMobileNativeChatSessionLane: () => ({ session, structuredSession: structured })
}))
vi.mock('../use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: 'ordinary message',
    setComposerText: vi.fn(),
    getComposerEditGeneration: () => 0,
    appendComposerText: () => true,
    pending: [],
    imagePreviewsByMessageId: {},
    captureSendOrigin: (text: string) => ({ draftKey: 'draft', normalizedText: text }),
    readSeededLaunchDraft: () => null,
    readSeededLaunchDraftSeed: () => null,
    clearDraftForSend: vi.fn(),
    restoreRejectedDraft: vi.fn(),
    acceptSend: vi.fn(),
    holdUnconfirmedSend: vi.fn()
  })
}))
vi.mock('../use-mobile-native-chat-session-option-controller', () => ({
  useMobileNativeChatSessionOptionController: () => ({
    nativeChatSessionOptions: undefined,
    recordCommand: vi.fn()
  })
}))
vi.mock('../use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
vi.mock('../use-mobile-native-chat-composer-tray', () => ({
  NO_COMPOSER_TRAY: {},
  useMobileNativeChatComposerTray: () => ({})
}))
vi.mock('../use-mobile-native-chat-streaming-bubble', () => ({
  useMobileNativeChatStreamingBubble: () => null
}))

let tree: ReactTestRenderer | null = null
let controller: MobileNativeChatController
let lastProps: HarnessProps | null = null
export const handleRef = { current: 'term-1' }
export const sendError = vi.fn()
const resolved = vi.fn()
let client: RpcClient

export function response(
  accepted = true,
  outcome: 'accepted' | 'refused' | 'unverifiable' | 'legacy' = accepted ? 'accepted' : 'refused'
): RpcResponse {
  return {
    id: 'send',
    ok: true,
    result: {
      send: { accepted, ...(outcome === 'legacy' ? {} : { writeSettlement: { outcome } }) }
    },
    _meta: { runtimeId: 'r' }
  }
}
export const baseTab = {
  type: 'terminal',
  launchAgent: 'claude',
  agentStatus: {
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    updatedAt: 10,
    paneKey: 'tab-1:leaf-1',
    stateHistory: [],
    stateStartedAt: 10,
    providerSession: { id: 'session-1', key: 'session_id' },
    lastAssistantMessage: 'Pick destination?\n1. East\n2. West'
  }
} satisfies MobileNativeChatTab
export const permissionTab = {
  ...baseTab,
  agentStatus: {
    ...baseTab.agentStatus,
    lastAssistantMessage: '',
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'echo yes' } })
  }
} satisfies MobileNativeChatTab
type HarnessProps = {
  tab?: MobileNativeChatTab
  tabId?: string
  connState?: ConnectionState
}
function Harness(props: HarnessProps) {
  const { tab = baseTab, tabId = 'tab-1', connState = 'connected' } = props
  const current = useMobileNativeChatController({
    client,
    hostId: 'host',
    worktreeId: 'folder:work',
    activeSessionTab: tab,
    activeSessionTabId: tabId,
    activeHandleRef: handleRef,
    deviceTokenRef: { current: null },
    nativeChatTranscriptIsLocalReadable: true,
    nativeChatInputLeaseReady: true,
    connState,
    onSendError: sendError,
    onSendResolved: resolved
  })
  captureRenderedController(current)
  return createElement(MobileNativeChatOverlay, {
    controller: current,
    onOpenFile: vi.fn(),
    images: {
      sendNativeChat: controller.handleNativeChatSend,
      attachments: [],
      isAttaching: false,
      attachImage: async () => {},
      removeAttachment: () => {}
    },
    onMicPress: vi.fn(),
    onMicPressOut: vi.fn(),
    onMicPressIn: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    inputLockReason: connState === 'connected' ? null : 'disconnected',
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'surface',
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0
  })
}
export async function render(props: HarnessProps = lastProps ?? {}) {
  lastProps = props
  await act(async () => {
    const element = createElement(Harness, props)
    if (tree) {
      tree.update(element)
    } else {
      tree = create(element)
    }
  })
}
export function sendButton() {
  return getTree().root.findByProps({ accessibilityLabel: 'Send message' })
}
/** Index 1 is Deny. */
export function permissionAction(index = 1) {
  return getTree()
    .root.findByProps({ testID: 'native-chat-approval-actions' })
    .findAllByType(Pressable)[index]
}
export function questionOption() {
  return getTree()
    .root.findAllByType(Pressable)
    .find((node) => node.findAllByType(Text).some((text) => text.children.includes('East')))
}
export async function unmount() {
  await act(async () => tree?.unmount())
  tree = null
}
export function reset(rpcClient: RpcClient) {
  client = rpcClient
  visible.value = true
  handleRef.current = 'term-1'
  lastProps = null
  sendError.mockReset()
  resolved.mockReset()
  mobileNativeChatPromptDismissals.clearForTests()
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) =>
    setTimeout(() => callback(0), 0)
  )
}
export function getTree(): ReactTestRenderer {
  if (!tree) {
    throw new Error('not rendered')
  }
  return tree
}
function captureRenderedController(value: MobileNativeChatController): void {
  controller = value
}
export function getController(): MobileNativeChatController {
  return controller
}
export function askCancel(): Promise<boolean> {
  return getTree().root.findByType(MobileNativeChatAsk).props.onCancel()
}
export function askCollapse(): void {
  getTree().root.findByType(MobileNativeChatAsk).props.onCollapse()
}
export function askAnswer(selections: AskAnswerSelection[]): Promise<boolean> {
  return getTree().root.findByType(MobileNativeChatAsk).props.onAnswer(selections)
}
