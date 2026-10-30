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
  connected = true,
  messages,
  olderPages,
  loadEarlier
}: {
  state: StructuredAgentSessionState
  connected?: boolean
  messages: NativeChatMessage[]
  olderPages: OlderPagePhase
  loadEarlier: () => void
}): MobileNativeChatSession {
  const { status } = state
  const questions = currentMessageQuestionView(state)
  return {
    messages,
    asyncQuestion: authoritativeAsyncQuestion(state),
    messageQuestions: questions ? { ...questions, ready: questions.ready && connected } : undefined,
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
