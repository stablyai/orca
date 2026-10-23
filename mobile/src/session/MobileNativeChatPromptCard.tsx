import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
  expanded = false,
  compact = false,
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
  expanded?: boolean
  compact?: boolean
  ask?: AskPrompt | null
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  requiresTerminal?: boolean
  onAnswerInTerminal?: () => void
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
  const card =
    ask && requiresTerminal ? (
      <ScrollView
        style={styles.terminalScroll}
        contentContainerStyle={styles.terminalCard}
        keyboardShouldPersistTaps="always"
      >
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
      </ScrollView>
    ) : ask ? (
      <MobileNativeChatAsk
        key={askKey ?? 'ask'}
        prompt={ask}
        expanded={expanded}
        compact={compact}
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
      <View
        style={
          collapsedPrompt
            ? styles.collapsed
            : ask
              ? [styles.ask, expanded && styles.expanded]
              : undefined
        }
      >
        {card}
      </View>
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
  ask: { maxHeight: '65%', flexShrink: 1, minHeight: 0 },
  expanded: { flex: 1, maxHeight: '100%' },
  collapsed: { display: 'none' },
  terminalScroll: { flexShrink: 1, minHeight: 0 },
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
