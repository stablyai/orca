import {
  authoritativeAsyncQuestion,
  currentMessageQuestionView
} from '../../../src/shared/agent-session-current-requests'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { MobileNativeChatSession } from './mobile-native-chat-session-contract'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

export function projectMobileStructuredChatSession({
  state,
  messages,
  olderPages,
  loadEarlier
}: {
  state: StructuredAgentSessionState
  messages: NativeChatMessage[]
  olderPages: OlderPagePhase
  loadEarlier: () => void
}): MobileNativeChatSession {
  const { status } = state
  return {
    messages,
    asyncQuestion: authoritativeAsyncQuestion(state),
    messageQuestions: currentMessageQuestionView(state),
    status,
    transcriptLoading: status === 'loading',
    error: state.error,
    readFailedFinally: status === 'error' && isFinalAgentSessionReadRefusal(state.readRefusal),
    hasMore: state.hasOlder && olderPages !== 'unavailable',
    loadingEarlier: olderPages === 'loading',
    olderPages,
    loadEarlier
  }
}
