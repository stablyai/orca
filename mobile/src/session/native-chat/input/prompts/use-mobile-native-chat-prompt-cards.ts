import { useMemo, useState } from 'react'
import type { MobileNativeChatController } from '../../mobile-native-chat-controller-contract'
import { mobileChatQuestionKey } from './mobile-native-chat-question'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import type { useMobileStructuredAgentSession } from '../../agent-session/use-mobile-structured-agent-session'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useMobileNativeChatPromptPresentation } from './use-mobile-native-chat-prompt-presentation'

export function useMobileNativeChatPromptCards({
  terminal,
  structured,
  onSendResolved
}: {
  terminal: Parameters<typeof useMobileNativeChatPromptPresentation>[0]
  structured: Pick<
    ReturnType<typeof useMobileStructuredAgentSession>,
    'permission' | 'question' | 'respondPermission' | 'respondQuestion' | 'cancelPrompt' | 'turnId'
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
  // Only a stepped question folds: a structured permission keeps its card until it is answered.
  const stepped = structured && !structured.permission ? structured.question : null
  const steppedKey = stepped?.questions ? mobileChatQuestionKey(stepped) : null
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null)
  const steppedTitle = stepped?.questions?.[0]?.question ?? stepped?.question ?? ''
  const collapsedStepped = useMemo<MobileNativeChatCollapsedPrompt | null>(
    () =>
      steppedKey !== null && collapsedKey === steppedKey
        ? { title: steppedTitle, expand: () => setCollapsedKey(null), holdsInput: true }
        : null,
    [collapsedKey, steppedKey, steppedTitle]
  )
  const presentation = useMobileNativeChatPromptPresentation({
    ...terminal,
    respondPermission: respond
  })
  return {
    nativeChatPermission: structured ? structured.permission : presentation.permission,
    nativeChatQuestion: structured ? structured.question : null,
    nativeChatPromptKey: structured ? null : presentation.occurrenceKey,
    handleNativeChatRespondPermission: structured ? respond : presentation.respondPermission,
    handleNativeChatQuestionAnswer: structured?.respondQuestion,
    // A card's X stops its turn; a Pi dialog can open with no turn running, and then nothing can.
    handleNativeChatCancelPrompt: structured?.turnId ? cancel : undefined,
    collapseNativeChatPrompt: structured
      ? steppedKey === null
        ? undefined
        : () => setCollapsedKey(steppedKey)
      : presentation.permission?.startupDialog
        ? undefined
        : presentation.collapsePrompt,
    nativeChatCollapsedPrompt: structured ? collapsedStepped : presentation.collapsed
  }
}
