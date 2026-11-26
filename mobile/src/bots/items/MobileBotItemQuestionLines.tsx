// A Needs you comment's question lines on the phone. An open line reads as the question, except while the
// answer card docked at the bottom (MobileBotItemAskCard) asks it. Answered, a line reads
// "Question → answer", muted, and the answer's own comment is not drawn again.
import { Pressable, Text, View } from 'react-native'
import {
  botItemQuestionLine,
  type BotItemQuestionShape
} from '../../../../src/shared/bots/bot-item-ask'
import { botItemAnswerWords } from '../../../../src/shared/bots/bot-item-answer-lines'
import {
  botItemShownAskEnd,
  type BotItemAskEnd
} from '../../../../src/shared/bots/bot-item-question-answers'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import type { BotItemSentAnswers } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileNativeChatMarkdown } from '../../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { colors, pressedStyle, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []

export function MobileBotItemQuestionLines({
  shape,
  askId,
  waiting,
  answers = NO_ANSWERS,
  byOrder,
  ended = null,
  onShowLive,
  sent = null,
  asking = false
}: {
  shape: BotItemQuestionShape
  /** The ask's event id. */
  askId: string
  /** The item waits on this question now. */
  waiting: boolean
  /** Per line, the owner comment that answered it. */
  answers?: readonly (BotItemEvent | null)[]
  /** Per line, answered only by a comment naming no line: that comment shows as itself. */
  byOrder?: readonly boolean[]
  /** Why its open lines take no answer: a later ask replaced them, or the owner skipped them. */
  ended?: BotItemAskEnd | null
  /** Replaced: shows the ask that waits now. */
  onShowLive?: () => void
  /** Answers just posted as one comment, shown on their lines until the host's read has it. */
  sent?: BotItemSentAnswers | null
  /** The docked answer card asks its open lines now: they aren't repeated here. */
  asking?: boolean
}) {
  const t = useMobileTranslation()
  const several = shape.decisions.length > 1
  const posted = sent?.askId === askId ? sent.answers : null
  const answered = shape.decisions.map((_, index) => {
    // With several questions, a comment that named no line shows as itself, not as the line's answer.
    const answer = several && byOrder?.[index] ? null : answers[index]
    return answer ? botItemAnswerWords(shape, index, answer.data) : (posted?.[index] ?? null)
  })
  const shown = shape.decisions.flatMap((decision, index) =>
    answered[index] || !(asking && waiting && !answers[index]) ? [{ decision, index }] : []
  )
  const shownEnd = botItemShownAskEnd(ended, answered)
  if (shown.length === 0) {
    return null
  }
  return (
    <View style={[several ? styles.several : styles.one, shape.body.trim() && styles.spaced]}>
      {shown.map(({ decision, index }) => {
        const words = answered[index]
        return words ? (
          <Text key={decision.question} style={styles.answerLine}>
            {botItemQuestionLine(decision.question)} →{' '}
            <Text style={styles.answerWords}>{words}</Text>
          </Text>
        ) : (
          // A decision's question is unique within its ask.
          <MobileNativeChatMarkdown
            key={decision.question}
            content={decision.question}
            tone={waiting && !answers[index] ? 'strong' : 'muted'}
            rangeSelectable={INLINE_TEXT_SELECTION}
          />
        )
      })}
      {shownEnd === 'replaced' && onShowLive ? (
        <Pressable
          style={({ pressed }) => [styles.endedRow, pressed && pressedStyle]}
          onPress={onShowLive}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.ended}>
            {t('bots.items.ask.replacedByNewer', 'Replaced by a newer question')}
          </Text>
        </Pressable>
      ) : shownEnd ? (
        <Text style={styles.ended}>
          {shownEnd === 'skipped'
            ? t('bots.items.ask.skipped', 'Skipped')
            : t('bots.items.ask.replacedByNewer', 'Replaced by a newer question')}
        </Text>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  spaced: { marginTop: spacing.sm },
  one: { gap: spacing.sm },
  several: { gap: spacing.xs },
  ended: { fontSize: 12, lineHeight: 16, color: colors.textMuted },
  endedRow: { alignSelf: 'flex-start' },
  answerLine: { fontSize: 13, lineHeight: 19, color: colors.textMuted },
  answerWords: { color: colors.textSecondary }
}))
