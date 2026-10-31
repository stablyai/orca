import './mobile-prompt-render-mocks'
import { createElement } from 'react'
import { Pressable } from 'react-native'
import type { NativeChatMessage } from '../../../../src/shared/native-chat-types'
import type { MobileNativeChatSendOutcome } from '../native-chat/mobile-native-chat-send'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse, ConnectionState } from '../../transport/types'
import type { MobileNativeChatTab } from '../native-chat/mobile-native-chat-eligibility'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { vi } from 'vitest'
import { useMobileNativeChatController } from '../use-mobile-native-chat-controller'
import { MobileNativeChatOverlay } from '../MobileNativeChatOverlay'
import { MobileNativeChatAsk } from '../native-chat/input/MobileNativeChatAsk'
import type { AskAnswerSelection } from '../../../../src/shared/native-chat-ask-answer'
import { mobileNativeChatPromptDismissals } from '../native-chat/input/mobile-native-chat-prompt-dismissals'
import { setMobileNativeChatDraftText } from '../native-chat/composer/mobile-native-chat-draft-store'
export const visible = { value: true }
const messages: NativeChatMessage[] = []
export const session = {
  messages,
  folded: [],
  status: 'ready',
  transcriptLoading: false
}
export const structuredSession = {
  asyncQuestionSourceScope: 'journal/host/session/epoch',
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
  sendWithOutcome: vi.fn<() => Promise<MobileNativeChatSendOutcome>>(async () => 'accepted'),
  cancel: vi.fn(),
  setStructuredOption: vi.fn(),
  invokeStructuredOption: vi.fn()
}
const sessionCommands = { commands: undefined, refresh: vi.fn() }
vi.mock('../use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: () => visible.value,
    setTabView: (_tabId: string, view: string) =>
      Object.assign(visible, { value: view === 'chat' }),
    toggleTabChatView: () => Object.assign(visible, { value: !visible.value })
  })
}))
vi.mock('../use-mobile-native-chat-session-lane', () => ({
  useMobileNativeChatSessionLane: () => ({ session, structuredSession, sessionCommands })
}))
setMobileNativeChatDraftText('draft', 'ordinary message')
vi.mock('../native-chat/composer/use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    draftKey: 'draft',
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
vi.mock('../native-chat/input/use-mobile-native-chat-session-option-controller', () => ({
  useMobileNativeChatSessionOptionController: () => ({
    nativeChatSessionOptions: undefined,
    recordCommand: vi.fn()
  })
}))
vi.mock('../native-chat/composer/use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
vi.mock('../native-chat/composer/use-mobile-native-chat-composer-tray', () => ({
  NO_COMPOSER_TRAY: {},
  useMobileNativeChatComposerTray: () => ({})
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
    providerSession: { id: 'session-1', key: 'session_id' }
  }
} satisfies MobileNativeChatTab
export const permissionTab = {
  ...baseTab,
  agentStatus: {
    ...baseTab.agentStatus,
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'echo yes' } })
  }
} satisfies MobileNativeChatTab
type HarnessProps = {
  tab?: MobileNativeChatTab
  tabId?: string
  connState?: ConnectionState
  hostId?: string
}
function Harness(props: HarnessProps) {
  const { tab = baseTab, tabId = 'tab-1', connState = 'connected', hostId = 'host' } = props
  const current = useMobileNativeChatController({
    client,
    hostId,
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
      sendNativeChat: (text: string) => controller.handleNativeChatSend(text),
      attachments: [],
      isAttaching: false,
      attachImage: async () => {},
      removeAttachment: () => {}
    },
    onMicPress: vi.fn(),
    onMicPressOut: vi.fn(),
    onMicPressIn: vi.fn(),
    micActive: false,
    micStarting: false,
    micProcessing: false,
    dictationMode: 'toggle',
    inputLockReason: connState === 'connected' ? null : 'disconnected',
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'surface',
    sessionId: null,
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0,
    hostName: null
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
export function permissionAction(index = 1) {
  return getTree()
    .root.findByProps({ testID: 'native-chat-approval-actions' })
    .findAllByType(Pressable)[index]
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
  session.messages = []
  structuredSession.asyncQuestionSourceScope = 'journal/host/session/epoch'
  structuredSession.sendWithOutcome.mockReset().mockResolvedValue('accepted')
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
