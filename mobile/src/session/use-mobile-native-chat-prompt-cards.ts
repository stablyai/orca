import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useMobileNativeChatPromptPresentation } from './use-mobile-native-chat-prompt-presentation'

/** Select the lane's existing card actions and apply terminal-only presentation dismissal. */
export function useMobileNativeChatPromptCards({
  terminal,
  structured,
  onSendResolved
}: {
  terminal: Parameters<typeof useMobileNativeChatPromptPresentation>[0]
  structured: Pick<
    ReturnType<typeof useMobileStructuredAgentSession>,
    'permission' | 'question' | 'respondPermission' | 'respondQuestion' | 'cancelPrompt'
  > | null
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
> {
  const respond = useNativeChatAcceptedAction(
    structured?.respondPermission ?? terminal.respondPermission,
    onSendResolved
  )
  const cancel = useNativeChatAcceptedAction(
    structured?.cancelPrompt ?? (async () => false),
    onSendResolved
  )
  const presentation = useMobileNativeChatPromptPresentation({
    ...terminal,
    respondPermission: respond
  })
  return {
    nativeChatPermission: structured ? structured.permission : presentation.permission,
    nativeChatQuestion: structured ? structured.question : presentation.question,
    nativeChatPromptKey: structured ? null : presentation.occurrenceKey,
    handleNativeChatRespondPermission: structured ? respond : presentation.respondPermission,
    handleNativeChatQuestionAnswer: structured
      ? structured.respondQuestion
      : presentation.answerQuestion,
    handleNativeChatCancelPrompt: structured ? cancel : undefined,
    collapseNativeChatPrompt: structured ? undefined : presentation.collapsePrompt,
    nativeChatCollapsedPrompt: structured ? null : presentation.collapsed
  }
}
