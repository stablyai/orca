import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { AskAnswerSelection, AskPrompt, parseAskFromStatus } from './mobile-native-chat-ask'
import type { detectAgentPermission } from './mobile-native-chat-permission'
import type { parseAgentQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import type { MobileNativeChatPendingMessage } from './use-mobile-native-chat-drafts'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'

export type MobileNativeChatControllerArgs = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  nativeChatInputLeaseReady: boolean
  /** Live socket state; the lease collapses on disconnect but one render later. */
  connState: ConnectionState
  onSendError: (message: string) => void
  /** Retires a held failure banner after an accepted chat write. */
  onSendResolved: () => void
}

export type MobileNativeChatController = {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  nativeChatAgent: string | null
  chatComposerText: string
  setChatComposerText: Dispatch<SetStateAction<string>>
  chatPending: MobileNativeChatPendingMessage[]
  chatImagePreviewsByMessageId: Record<string, string[]>
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  nativeChatAgentWorking: boolean
  nativeChatStreamingText?: string
  nativeChatStreamLive: boolean
  nativeChatStreamScopeKey: string
  nativeChatPermission: ReturnType<typeof detectAgentPermission>
  nativeChatQuestion: ReturnType<typeof parseAgentQuestion>
  nativeChatAsk: ReturnType<typeof parseAskFromStatus>
  nativeChatAskKey: string | null
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
  handleNativeChatSendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number
  ) => Promise<MobileNativeChatSendOutcome>
  readSeededLaunchDraft: () => string | null
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
}
