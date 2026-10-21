import { StyleSheet, View } from 'react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { mobileChatQuestionKey, type MobileChatQuestion } from './mobile-native-chat-question'
import { MobileNativeChatPromptStrip } from './MobileNativeChatPromptStrip'

/** The one pending agent prompt shown above the composer: a structured
 *  AskUserQuestion wins, then a heuristic permission, then a heuristic question.
 *  The controller owns dismissal (it must survive this subtree unmounting on a
 *  view toggle); `ask` arrives already nulled once answered. */
export function MobileNativeChatPromptCard({
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
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
  onCancelPrompt?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  onCollapseAsk?: () => void
  /** Fold the permission/question occurrence to a strip and free Send, writing nothing. */
  onCollapsePrompt?: () => void
  /** Set while the shown occurrence is collapsed: its card stays mounted but hidden under a strip. */
  collapsedPrompt?: { title: string; expand: () => void } | null
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
}): React.JSX.Element | null {
  const card = ask ? (
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
      onCollapse={onCollapseAsk}
    />
  ) : permission ? (
    <MobileNativeChatPermission
      key={JSON.stringify(permission)}
      permission={permission}
      onRespond={async (send) => (await onRespondPermission?.(send)) ?? false}
      onCancel={onCancelPrompt}
      onCollapse={onCollapsePrompt}
    />
  ) : question ? (
    <MobileNativeChatQuestion
      key={mobileChatQuestionKey(question)}
      question={question}
      onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
      onCancel={onCancelPrompt}
      onCollapse={onCollapsePrompt}
    />
  ) : null
  // Why one stable wrapper: collapsing hides the card without remounting it, so a partly answered
  // card keeps its selections.
  return (
    <>
      <View style={collapsedPrompt ? styles.collapsed : undefined}>{card}</View>
      {collapsedPrompt ? (
        <MobileNativeChatPromptStrip
          title={collapsedPrompt.title}
          onExpand={collapsedPrompt.expand}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({ collapsed: { display: 'none' } })
