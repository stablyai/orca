import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { mobileChatQuestionKey, type MobileChatQuestion } from './mobile-native-chat-question'

/** The one pending agent prompt shown above the composer: a structured
 *  AskUserQuestion wins, then a heuristic permission, then a heuristic question.
 *  The controller owns dismissal (it must survive this subtree unmounting on a
 *  view toggle); `ask` arrives already nulled while dismissed. */
export function MobileNativeChatPromptCard({
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  onCancelAsk,
  permission,
  onRespondPermission,
  question,
  onAnswerQuestion
}: {
  ask?: AskPrompt | null
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  onCancelAsk?: () => Promise<boolean>
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
}): React.JSX.Element | null {
  if (ask) {
    return (
      <MobileNativeChatAsk
        key={askKey ?? 'ask'}
        prompt={ask}
        onAnswer={async (selections) => {
          const accepted = (await onAnswerAsk?.(ask, selections)) ?? false
          if (accepted) {
            onDismissAsk?.()
          }
          return accepted
        }}
        onCancel={async () => {
          const accepted = (await onCancelAsk?.()) ?? false
          if (accepted) {
            onDismissAsk?.()
          }
          return accepted
        }}
      />
    )
  }
  if (permission) {
    return (
      <MobileNativeChatPermission
        key={JSON.stringify(permission)}
        permission={permission}
        onRespond={async (send) => (await onRespondPermission?.(send)) ?? false}
      />
    )
  }
  if (question) {
    return (
      <MobileNativeChatQuestion
        key={mobileChatQuestionKey(question)}
        question={question}
        onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
      />
    )
  }
  return null
}
