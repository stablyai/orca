import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  AskAnswerSelection,
  AskPrompt,
  parseAskFromStatus
} from '../../../src/shared/native-chat-ask'
import type { detectAgentPermission } from './mobile-native-chat-permission'
import type { parseAgentQuestion } from './mobile-native-chat-question'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../src/shared/native-chat-turn-status'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import type { MobileNativeChatPendingMessage } from './use-mobile-native-chat-drafts'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'

export type MobileNativeChatController = {
  /** Whether a tab's effective view is chat (per-tab override, else the default). */
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  /** Resolved agent for the active chat tab (names the empty-state copy). */
  nativeChatAgent: string | null
  chatComposerText: string
  setChatComposerText: Dispatch<SetStateAction<string>>
  getChatComposerEditGeneration: () => number
  chatPending: MobileNativeChatPendingMessage[]
  chatImagePreviewsByMessageId: Record<string, string[]>
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  /** Structured lane: drives the per-turn status row and live tool progress. */
  nativeChatStructured: boolean
  /** Structured lane with a live client: where the transcript's visuals are read from. */
  nativeChatVisualSource: MobileNativeChatVisualSource | null
  nativeChatAgentWorking: boolean
  /** What labels the live turn's one indicator row; null off the structured lane. */
  nativeChatTurnIndicator: NativeChatLiveTurnIndicator | null
  /** Structured lane: host-recorded turn timing for the per-turn status rows. */
  nativeChatWorkingStartedAt: number | null
  nativeChatSettledTurns: NativeChatSettledTurns | null
  /** Structured lane: the journal that places each transcript row in its turn. */
  nativeChatTurnJournal: NativeChatTurnJournal | null
  nativeChatCanStop: boolean
  nativeChatStreamingText?: string
  /** Agent mid-turn, regardless of whether chat is the visible view. */
  nativeChatStreamLive: boolean
  /** Host/workspace/tab/session scope for stateful streaming suppression. */
  nativeChatStreamScopeKey: string
  nativeChatPermission: ReturnType<typeof detectAgentPermission>
  /** Terminal prompt occurrence; a replacement resets only the card's local submission state. */
  nativeChatPromptKey: string | null
  nativeChatQuestion: ReturnType<typeof parseAgentQuestion>
  /** The pending ask, already null while dismissed (dismissal lives here so it
   *  survives the chat-view subtree unmounting on a view toggle). */
  nativeChatAsk: ReturnType<typeof parseAskFromStatus>
  /** Stable key for the current ask card (keys the card component). */
  nativeChatAskKey: string | null
  /** Hide the current ask until a genuinely different question arrives. */
  dismissNativeChatAsk: () => void
  handleNativeChatAnswerAsk: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[]
  ) => Promise<boolean>
  handleNativeChatCancelAsk: () => Promise<boolean>
  /** Terminal lane: fold the occurrence to a strip and free Send, writing nothing. */
  collapseNativeChatAsk: () => void
  collapseNativeChatPrompt?: () => void
  /** The collapsed terminal occurrence, shown as a strip above the composer. */
  nativeChatCollapsedPrompt: { title: string; expand: () => void } | null
  handleNativeChatCancelPrompt?: (prompt?: {
    itemId: string
    expectedRevision: number
  }) => Promise<boolean>
  handleNativeChatRespondPermission: (text: string) => Promise<boolean>
  handleNativeChatStop: () => void
  /** Host-held queued drafts shown as cards above the composer (structured lane; any host
   *  that publishes them). */
  nativeChatQueued: MobileStructuredQueuedMessageControls
  /** Running child work shown in a strip above the composer; null off the structured lane. */
  nativeChatBackgroundTasks: MobileStructuredBackgroundTasks | null
  nativeChatFilePaths: string[]
  loadNativeChatFiles: (query: string) => void
  handleNativeChatQuestionAnswer: (text: string) => Promise<boolean>
  handleNativeChatSend: (text: string, images?: string[]) => Promise<boolean>
  /** Outcome-preserving send: callers that pasted terminal input beforehand
   *  (image sends) must see 'unknown' to heal a possibly-orphaned paste. Such a
   *  caller passes its own `deadline` so the paste it already spent and this text
   *  body share one budget instead of holding the composer for two. */
  handleNativeChatSendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly {
      id?: string
      path: string
      previewUri: string
    }[]
  ) => Promise<MobileNativeChatSendOutcome>
  /** Launch-context text still parked on the agent's TUI input line, or null.
   *  Image sends read it to size their leading clear (one Ctrl+U per line). */
  readSeededLaunchDraft: () => string | null
  /** Model/session-option pickers for the composer, or null when the active
   *  agent has no session-option catalog. */
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
}
