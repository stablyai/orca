import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import type { MessageQuestionView } from '../../../src/shared/message-question-occurrence'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../src/shared/native-chat-types'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

export type MobileNativeChatStatus =
  | 'idle'
  | 'loading'
  | 'waiting-session'
  // No transcript file yet: render the empty chat while keeping its read unsettled.
  | 'awaiting-transcript'
  | 'ready'
  | 'error'

export type MobileNativeChatSession = {
  asyncQuestion?: AskPrompt | null
  messageQuestions?: MessageQuestionView
  cancelMessageQuestions?: (ids: readonly string[]) => Promise<void>
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  // Unsettled reads or passive resets may still hold another tab’s history; wait before interpreting empty messages as a seed/retirement boundary.
  transcriptLoading: boolean
  error?: string
  /** The read failed for good (damage, or a newer Orca's chat): the error says why, once, and
   *  there is nothing to send into. */
  readFailedFinally?: boolean
  hasMore: boolean
  /** `olderPages === 'loading'`, kept because recorded RPC fixtures read it. */
  loadingEarlier: boolean
  olderPages?: OlderPagePhase
  loadEarlier: () => void
  /** Latest provider turn boundary from the transcript feed; absent from older hosts. */
  transcriptLifecycle?: NativeChatTurnLifecycle
}
