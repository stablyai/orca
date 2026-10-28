import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { useMobileBridgeChatPromptWrites } from './use-mobile-bridge-chat-prompt-writes'
import { useMobileNativeChatAskDismiss } from './native-chat/input/use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatPromptCards } from './native-chat/input/use-mobile-native-chat-prompt-cards'
import { useMobileNativeChatPrompts } from './native-chat/input/use-mobile-native-chat-prompts'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'

// Read the chat's ask and permission/question prompts and route their answers to the active lane.
export function useMobileNativeChatPromptController({
  enabled,
  structured,
  status,
  session,
  scopeKey,
  sessionId,
  streamIdentity,
  visible,
  terminal,
  onSendResolved
}: {
  enabled: boolean
  structured: ReturnType<typeof useMobileStructuredAgentSession> | null
  status: AgentStatusEntry | null | undefined
  session: Pick<
    ReturnType<typeof useMobileNativeChatSession>,
    'messages' | 'transcriptLoading' | 'status'
  >
  scopeKey: string | null
  sessionId: string | null
  streamIdentity: string
  visible: boolean
  /** Terminal-bridge writes; a structured chat answers through its own session. */
  terminal: Pick<
    ReturnType<typeof useMobileBridgeChatPromptWrites>,
    'answerAsk' | 'cancelAsk' | 'respondPermission'
  >
  onSendResolved: () => void
}): Pick<
  MobileNativeChatController,
  | 'nativeChatPermission'
  | 'nativeChatQuestion'
  | 'nativeChatPromptKey'
  | 'handleNativeChatRespondPermission'
  | 'handleNativeChatQuestionAnswer'
  | 'handleNativeChatCancelPrompt'
  | 'collapseNativeChatPrompt'
  | 'nativeChatCollapsedPrompt'
  | 'nativeChatAsk'
  | 'nativeChatAskKey'
  | 'dismissNativeChatAsk'
  | 'collapseNativeChatAsk'
  | 'handleNativeChatAnswerAsk'
  | 'handleNativeChatCancelAsk'
> & { hasPromptCard: boolean } {
  const {
    permission: legacyNativeChatPermission,
    waitStartedAt: nativeChatPromptStartedAt,
    ask: nativeChatAskPrompt,
    structuredAnswer
  } = useMobileNativeChatPrompts({
    enabled,
    structured,
    status,
    messages: session.messages,
    transcriptLoading: session.transcriptLoading
  })
  // A never-read transcript cannot prove that a dismissed prompt cleared.
  const nativeChatTranscriptSettled =
    session.status === 'ready' || (session.status === 'error' && session.messages.length > 0)
  const askDismissal = useMobileNativeChatAskDismiss({
    ask: nativeChatAskPrompt,
    startedAt: nativeChatPromptStartedAt,
    scopeKey,
    sessionKey: sessionId,
    observing: visible && (nativeChatAskPrompt != null || nativeChatTranscriptSettled)
  })
  const answerAsk = useNativeChatAcceptedAction(
    structuredAnswer ?? terminal.answerAsk,
    onSendResolved
  )
  const cancelAsk = useNativeChatAcceptedAction(terminal.cancelAsk, onSendResolved)
  const promptCards = useMobileNativeChatPromptCards({
    terminal: {
      permission: legacyNativeChatPermission,
      waitStartedAt: nativeChatPromptStartedAt,
      scopeKey,
      sessionKey: streamIdentity,
      observing: visible && !structured && status != null,
      respondPermission: terminal.respondPermission
    },
    structured,
    onSendResolved
  })

  return {
    hasPromptCard: (legacyNativeChatPermission ?? nativeChatAskPrompt) != null,
    ...promptCards,
    nativeChatAsk: askDismissal.showAsk || askDismissal.collapsedAsk ? nativeChatAskPrompt : null,
    nativeChatAskKey: askDismissal.askKey,
    dismissNativeChatAsk: askDismissal.dismissAsk,
    collapseNativeChatAsk: askDismissal.collapseAsk,
    nativeChatCollapsedPrompt: askDismissal.collapsedAsk ?? promptCards.nativeChatCollapsedPrompt,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk
  }
}
