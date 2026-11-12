import type { NativeChatSkillDiscoverySnapshot } from '../../../../src/shared/native-chat/input/native-chat-picker-items'
import type { AgentSessionRewindSurface } from '../../../../src/shared/agent-session/lifecycle/agent-session-rewind-request'
import type { NativeChatSendFollowUp } from '../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import type { StructuredMobileSendAttachment } from './composer/use-mobile-structured-send-with-outcome'
import type { MobileSessionView } from '../../storage/session-view-preferences'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  AskAnswerSelection,
  NativeChatAnswerSource
} from '../../../../src/shared/native-chat/input/native-chat-ask-answer'
import type { AskPrompt } from '../../../../src/shared/native-chat/input/native-chat-ask-types'
import type { MobileChatPermission } from './input/mobile-native-chat-permission'
import type { MobileChatQuestion } from './input/mobile-native-chat-question'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../../src/shared/native-chat/transcript/native-chat-turn-status'
import type { AgentSessionOptionsResult } from '../../../../src/shared/agent-session/options/agent-session-options-result'
import type { NativeChatTurnJournal } from '../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import type { NativeChatAwaitingInput } from '../../../../src/shared/native-chat/native-chat-terminal-turn'
import type { NativeChatResolvedPrompt } from '../../../../src/shared/native-chat/native-chat-resolution-receipt'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from './composer/mobile-native-chat-send'
import type { MobileNativeChatCommandRefusalCauses } from './composer/use-mobile-native-chat-send-error'
import type { MobileStructuredQueuedMessageControls } from './input/use-mobile-structured-queued-message-controls'
import type { MobileStructuredThreadGoal } from './input/use-mobile-structured-thread-goal'
import type { MobileStructuredBackgroundTasks } from './input/use-mobile-structured-background-tasks'
import type { MobileStructuredInterruptedContinue } from './composer/use-mobile-structured-interrupted-continue'
import type { MobileStructuredSignedOutRetry } from './composer/use-mobile-structured-signed-out-retry'
import type { MobileNativeChatPendingMessage } from './transcript/mobile-native-chat-pending-echo'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatSessionOptionPickersProps } from './input/MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatVisualSource } from './visual/mobile-native-chat-visual-read'
import type { NativeChatContextUsageSummary } from '../../../../src/shared/native-chat/native-chat-context-usage-summary'
import type { useMobileStructuredSessionCommands } from './composer/use-mobile-structured-session-commands'
import type { MobileNativeChatUsageLimit } from './use-mobile-native-chat-usage-limit'

export type MobileNativeChatController = {
  sessionViewReady: boolean
  isTabChatView: (tabId: string) => boolean
  setTabView: (tabId: string, view: MobileSessionView) => void
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  nativeChatAgent: string | null
  nativeChatSessionLive: boolean
  chatComposerScopeKey?: string | null
  reportQueuedEditError?: (message: string) => void
  chatDraftKey: string | null
  setChatComposerText: Dispatch<SetStateAction<string>>
  getChatComposerEditGeneration: () => number
  chatPending: MobileNativeChatPendingMessage[]
  chatImagePreviewsByMessageId: Record<string, string[]>
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  nativeChatStructured: boolean
  nativeChatVisualSource: MobileNativeChatVisualSource | null
  nativeChatItemSource: MobileNativeChatVisualSource | null
  /** The paired desktop's CI result lines setting; false until it reports one. */
  nativeChatShowsCiResultLines: boolean
  /** Working or waiting on the reader: keeps the turn clock running. */
  nativeChatTurnActive: boolean
  nativeChatAwaitingInput: NativeChatAwaitingInput | null
  nativeChatTurnIndicator: NativeChatLiveTurnIndicator | null
  nativeChatWorkingStartedAt: number | null
  nativeChatSettledTurns: NativeChatSettledTurns | null
  nativeChatTurnJournal: NativeChatTurnJournal | null
  nativeChatReceipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  nativeChatActionablePromptIds: readonly string[] | undefined
  nativeChatCommandRefusalCauses: MobileNativeChatCommandRefusalCauses
  nativeChatCanStop: boolean
  /** While the agent works on a host that queues: what a tap on Send does and whether holding it offers the other way; null otherwise. */
  nativeChatSendFollowUp: NativeChatSendFollowUp | null
  nativeChatStreamingText?: string
  nativeChatPermission: MobileChatPermission | null
  // A new prompt occurrence resets local card submission state only.
  nativeChatPromptKey: string | null
  /** Only a structured chat's journal question; a terminal chat's questions are asks. */
  nativeChatQuestion: MobileChatQuestion | null
  // Keep dismissal above chat-view unmounts so toggling views cannot resurrect an answered ask.
  nativeChatAsk: AskPrompt | null
  nativeChatAskSendSource?: NativeChatAnswerSource
  nativeChatAskPending?: boolean
  nativeChatAskKey: string | null
  dismissNativeChatAsk: () => void
  handleNativeChatAnswerAsk: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[],
    onCreated?: (id: string) => void
  ) => Promise<boolean>
  handleNativeChatCancelAsk: () => Promise<boolean>
  // Collapse writes nothing to the terminal and frees Send.
  collapseNativeChatAsk: () => void
  collapseNativeChatPrompt?: () => void
  nativeChatCollapsedPrompt: { title: string; expand: () => void } | null
  handleNativeChatCancelPrompt?: (prompt?: {
    itemId: string
    expectedRevision: number
  }) => Promise<boolean>
  handleNativeChatRespondPermission: (text: string) => Promise<boolean>
  handleNativeChatStop: () => void
  nativeChatQueued: MobileStructuredQueuedMessageControls
  nativeChatBackgroundTasks: MobileStructuredBackgroundTasks | null
  nativeChatContextUsage: NativeChatContextUsageSummary | null
  nativeChatInterruptedContinue: MobileStructuredInterruptedContinue | null
  nativeChatSignedOutRetry: MobileStructuredSignedOutRetry | null
  nativeChatThreadGoal: MobileStructuredThreadGoal | null
  nativeChatRewind: AgentSessionRewindSurface | undefined
  nativeChatFilePaths: string[]
  loadNativeChatFiles: (query: string) => void
  nativeChatSkills: NativeChatSkillDiscoverySnapshot
  loadNativeChatSkills: () => void
  /** A grouped structured answer names the prompt it was rendered for. */
  handleNativeChatQuestionAnswer?: (
    text: string,
    prompt?: MobileChatQuestion['prompt']
  ) => Promise<boolean>
  handleNativeChatSend: (text: string, images?: string[]) => Promise<boolean>
  // Preserve unknown outcomes to heal orphaned image pastes; share their deadline with text and retain the original pre-paste sentAt.
  handleNativeChatSendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    sentAt?: number,
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>
  // Read parked TUI launch text to clear one line per Ctrl+U before pasting images.
  readSeededLaunchDraft: () => string | null
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
  nativeChatSessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  nativeChatAcceptsImages: boolean
  /** The structured chat's options read on whether its agent forks; absent until it answers. */
  nativeChatForkSupport?: AgentSessionOptionsResult['forkSupport']
  nativeChatUsageLimit: MobileNativeChatUsageLimit | null
}
