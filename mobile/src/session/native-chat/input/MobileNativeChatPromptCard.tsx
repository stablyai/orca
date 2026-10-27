import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import type { AskAnswerSelection } from '../../../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { MobileNativeChatStructuredAsk } from './MobileNativeChatStructuredAsk'
import { mobileChatQuestionKey, type MobileChatQuestion } from './mobile-native-chat-question'
import { MobileNativeChatPromptStrip } from './MobileNativeChatPromptStrip'

// Keep dismissal in the controller across chat/terminal toggles; the shared resolver already chose the terminal card.
export function MobileNativeChatPromptCard({
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  requiresTerminal = false,
  onAnswerInTerminal,
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
  requiresTerminal?: boolean
  onAnswerInTerminal?: () => void
  onCancelAsk?: () => Promise<boolean>
  onCancelPrompt?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string, prompt?: MobileChatQuestion['prompt']) => Promise<boolean>
}): React.JSX.Element | null {
  const card =
    ask && requiresTerminal ? (
      <View style={styles.terminalCard}>
        <Text style={styles.explanation}>Answer this OMP question in the terminal.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Answer in terminal"
          accessibilityState={{ disabled: !onAnswerInTerminal }}
          disabled={!onAnswerInTerminal}
          onPress={onAnswerInTerminal}
          style={styles.terminalButton}
        >
          <Text style={styles.terminalButtonText}>Answer in terminal</Text>
        </Pressable>
      </View>
    ) : ask ? (
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
          // The agent is not waiting on this card, and Escape would interrupt its turn.
          const accepted = ask.replyAsMessage ? true : ((await onCancelAsk?.()) ?? false)
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
    ) : question?.questions ? (
      <MobileNativeChatStructuredAsk
        key={mobileChatQuestionKey(question)}
        questions={question.questions}
        onAnswer={async (answers) => (await onAnswerQuestion?.(answers, question.prompt)) ?? false}
        onCancel={onCancelPrompt && (() => onCancelPrompt(question.prompt))}
      />
    ) : question ? (
      <MobileNativeChatQuestion
        key={mobileChatQuestionKey(question)}
        question={question}
        onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
        onCancel={onCancelPrompt}
      />
    ) : null
  // Hide without remounting so a collapsed prompt keeps partial selections.
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

const styles = StyleSheet.create({
  collapsed: { display: 'none' },
  terminalCard: {
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    padding: spacing.md,
    gap: spacing.sm
  },
  explanation: { color: colors.textPrimary, fontSize: typography.bodySize },
  terminalButton: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md
  },
  terminalButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
