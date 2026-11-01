import { useMobileAsyncQuestionHides } from './native-chat/input/use-mobile-native-chat-prompt-dismiss'
import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import type { AskAnswerSelection } from '../../../src/shared/native-chat-ask-answer'
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
  asyncSourceScope,
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
  asyncSourceScope: string
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
  const asyncHides = useMobileAsyncQuestionHides(scopeKey, asyncSourceScope, streamIdentity)
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
    transcriptLoading: session.transcriptLoading,
    asyncSourceScope,
    hiddenAsyncIds: asyncHides.hidden
  })
  // A never-read transcript cannot prove that a dismissed prompt cleared.
  const nativeChatTranscriptSettled =
    session.status === 'ready' || (session.status === 'error' && session.messages.length > 0)
  const askDismissal = useMobileNativeChatAskDismiss({
    ask: nativeChatAskPrompt,
    dismissAsync: asyncHides.capture(nativeChatAskPrompt?.occurrenceIds ?? []),
    startedAt: nativeChatPromptStartedAt,
    scopeKey,
    sessionKey: nativeChatAskPrompt?.replyAsMessage ? streamIdentity : sessionId,
    observing: visible && (nativeChatAskPrompt != null || nativeChatTranscriptSettled)
  })
  const answerAsk = useNativeChatAcceptedAction(
    async (prompt: AskPrompt, selections: AskAnswerSelection[]) => {
      const hide = asyncHides.capture(prompt.occurrenceIds ?? [])
      const accepted = await (structuredAnswer ?? terminal.answerAsk)(prompt, selections)
      // Only terminal writes acknowledge delivery; structured admission leaves retirement to rows.
      if (accepted && prompt.replyAsMessage && !structuredAnswer) {
        hide()
      }
      return accepted
    },
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
