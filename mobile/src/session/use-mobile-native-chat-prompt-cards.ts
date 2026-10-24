import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useMobileNativeChatPromptPresentation } from './use-mobile-native-chat-prompt-presentation'

/** Select the lane's existing card actions and apply terminal-only presentation dismissal. */
export function useMobileNativeChatPromptCards({
  terminal,
  structured,
  structuredAnswer,
  onSendResolved
}: {
  terminal: Parameters<typeof useMobileNativeChatPromptPresentation>[0] &
    Pick<MobileNativeChatController, 'handleNativeChatAnswerAsk' | 'handleNativeChatCancelAsk'>
  structured: Pick<
    ReturnType<typeof useMobileStructuredAgentSession>,
    'permission' | 'question' | 'respondPermission' | 'respondQuestion' | 'cancelPrompt' | 'turnId'
  > | null
  structuredAnswer?: MobileNativeChatController['handleNativeChatAnswerAsk'] | null
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
  | 'handleNativeChatAnswerAsk'
  | 'handleNativeChatCancelAsk'
> {
  const answerAsk = useNativeChatAcceptedAction(
    structuredAnswer ?? terminal.handleNativeChatAnswerAsk,
    onSendResolved
  )
  const cancelAsk = useNativeChatAcceptedAction(terminal.handleNativeChatCancelAsk, onSendResolved)
  const respond = useNativeChatAcceptedAction(
    structured?.respondPermission ?? terminal.respondPermission,
    onSendResolved
  )
  const answerQuestion = useNativeChatAcceptedAction(terminal.answerQuestion, onSendResolved)
  const cancel = useNativeChatAcceptedAction(
    structured?.cancelPrompt ?? (async () => false),
    onSendResolved
  )
  const presentation = useMobileNativeChatPromptPresentation({
    ...terminal,
    respondPermission: respond,
    answerQuestion
  })
  return {
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    nativeChatPermission: structured ? structured.permission : presentation.permission,
    nativeChatQuestion: structured ? structured.question : presentation.question,
    nativeChatPromptKey: structured ? null : presentation.occurrenceKey,
    handleNativeChatRespondPermission: structured ? respond : presentation.respondPermission,
    handleNativeChatQuestionAnswer: structured
      ? structured.respondQuestion
      : presentation.answerQuestion,
    // A card's X stops its turn; a Pi dialog can open with no turn running, and then nothing can.
    handleNativeChatCancelPrompt: structured?.turnId ? cancel : undefined,
    collapseNativeChatPrompt: structured ? undefined : presentation.collapsePrompt,
    nativeChatCollapsedPrompt: structured ? null : presentation.collapsed
  }
}
