import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { detectAgentPermission } from './mobile-native-chat-permission'
import type { parseAgentQuestion } from './mobile-native-chat-question'
import type { AskAnswerSelection, AskPrompt, parseAskFromStatus } from './mobile-native-chat-ask'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatPendingMessage } from './use-mobile-native-chat-drafts'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'

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
  chatPending: MobileNativeChatPendingMessage[]
  chatImagePreviewsByMessageId: Record<string, string[]>
  nativeChatDeliveryFailed: boolean
  showNativeChatTerminal: () => void
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  nativeChatAgentWorking: boolean
  nativeChatStreamingText?: string
  /** Agent mid-turn, regardless of whether chat is the visible view. */
  nativeChatStreamLive: boolean
  /** Host/workspace/tab/session scope for stateful streaming suppression. */
  nativeChatStreamScopeKey: string
  nativeChatPermission: ReturnType<typeof detectAgentPermission>
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
  handleNativeChatRespondPermission: (text: string) => Promise<boolean>
  handleNativeChatStop: () => void
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
    deadline?: number
  ) => Promise<MobileNativeChatSendOutcome>
  /** Launch-context text still parked on the agent's TUI input line, or null.
   *  Image sends read it to size their leading clear (one Ctrl+U per line). */
  readSeededLaunchDraft: () => string | null
  /** Model/session-option pickers for the composer, or null when the active
   *  agent has no session-option catalog. */
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
}
