import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  AskAnswerSelection,
  AskPrompt,
  parseAskFromStatus
} from '../../../src/shared/native-chat-ask'
import type { detectAgentPermission } from './mobile-native-chat-permission'
import type { parseAgentQuestion } from './mobile-native-chat-question'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatPendingMessage } from './use-mobile-native-chat-pending-deliveries'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'

export type MobileNativeChatController = {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  nativeChatAgent: string | null
  chatComposerText: string
  setChatComposerText: Dispatch<SetStateAction<string>>
  getChatComposerEditGeneration: () => number
  chatPending: MobileNativeChatPendingMessage[]
  chatImagePreviewsByMessageId: Record<string, string[]>
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  /** Structured lane: drives the per-turn status row and live tool progress. */
  nativeChatStructured: boolean
  nativeChatAgentWorking: boolean
  nativeChatTargetRef: MutableRefObject<HostSessionNativeChatTarget | null>
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
    deadline?: number,
    attachments?: readonly {
      id?: string
      path: string
      previewUri: string
    }[]
  ) => Promise<MobileNativeChatSendOutcome>
  readSeededLaunchDraft: () => string | null
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
}
