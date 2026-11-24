// The desktop's BotItemQuestionStep on the phone: the waiting ask of several questions, one line at a
// time. The lines answered so far fold above as "Question → answer" (a held one reopens on tap), then
// the open line with ‹ 2 of 4 › and its quick replies. A quick reply or the comment box's send answers
// the line and the step moves on; answers wait until the last line or "send anyway".
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronLeft, ChevronRight, Pencil } from '../../components/icons/app-icons'
import {
  botItemQuestionLine,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../src/shared/bots/bot-item-ask'
import type {
  BotItemQuestionSteps,
  BotItemQuickReplyActions
} from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { colors, feedback, pressedStyle, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const ICON = 12

/** One quick reply's pill: `filled` the recommended reply of an open line, `picked` the one held. */
export function MobileBotItemChip({
  reply,
  filled = false,
  picked = false,
  disabled = false,
  onPress
}: {
  reply: BotItemQuickReply
  filled?: boolean
  picked?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const t = useMobileTranslation()
  const recommended = t('bots.items.ask.recommended', 'Recommended')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reply.recommended ? `${reply.label}, ${recommended}` : reply.label}
      accessibilityHint={reply.detail || undefined}
      accessibilityState={{ selected: picked, disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        picked ? styles.chipPicked : filled ? styles.chipFilled : null,
        disabled ? styles.disabled : pressed && pressedStyle
      ]}
    >
      {picked ? <Check size={ICON} color={colors.textPrimary} /> : null}
      <Text style={[styles.chipText, filled && !picked ? styles.chipTextFilled : null]}>
        {reply.recommended ? <Text style={styles.star}>★ </Text> : null}
        {reply.label}
      </Text>
    </Pressable>
  )
}

/** Muted, with a pencil: your own words are the other way to answer. */
export function MobileBotItemTypeAnswerChip({
  disabled = false,
  onPress
}: {
  disabled?: boolean
  onPress: () => void
}) {
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, disabled ? styles.disabled : pressed && pressedStyle]}
    >
      <Pencil size={ICON} color={colors.textMuted} />
      <Text style={[styles.chipText, styles.chipTextMuted]}>
        {t('bots.items.ask.typeAnswer', 'Type your answer')}
      </Text>
    </Pressable>
  )
}

/** "Question → answer", muted: an answered line, or one held on this device ("not sent yet") that
 *  reopens on tap. */
export function MobileBotItemAnswerLine({
  question,
  words,
  onPress
}: {
  question: string
  words: string
  onPress?: () => void
}) {
  const t = useMobileTranslation()
  const content = (
    <Text style={styles.answerLine}>
      {botItemQuestionLine(question)} → <Text style={styles.answerWords}>{words}</Text>
      {onPress ? <> · {t('bots.items.ask.notSentYet', 'not sent yet')}</> : null}
    </Text>
  )
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => pressed && pressedStyle}
    >
      {content}
    </Pressable>
  ) : (
    content
  )
}

function StepNav({ steps }: { steps: BotItemQuestionSteps }) {
  const t = useMobileTranslation()
  const at = steps.lines.indexOf(steps.current)
  const previous = at > 0 ? steps.lines[at - 1] : undefined
  const next = at < steps.lines.length - 1 ? steps.lines[at + 1] : undefined
  const arrow = (to: number | undefined, label: string, Icon: typeof ChevronLeft) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={to === undefined}
      hitSlop={8}
      onPress={() => to !== undefined && steps.go(to)}
      style={({ pressed }) => [
        styles.arrow,
        to === undefined ? styles.disabled : pressed && pressedStyle
      ]}
    >
      <Icon size={15} color={colors.textMuted} />
    </Pressable>
  )
  return (
    <View style={styles.nav}>
      {arrow(previous, t('bots.items.ask.previous', 'Previous question'), ChevronLeft)}
      <Text style={styles.navText}>
        {t('bots.items.ask.step', '{{n}} of {{total}}', { n: at + 1, total: steps.lines.length })}
      </Text>
      {arrow(next, t('bots.items.ask.next', 'Next question'), ChevronRight)}
    </View>
  )
}

export function MobileBotItemQuestionStep({
  shape,
  answered,
  steps,
  actions,
  disabled
}: {
  shape: BotItemQuestionShape
  /** Per line, the words a posted comment answered it with. */
  answered: readonly (string | null)[]
  steps: BotItemQuestionSteps
  actions: BotItemQuickReplyActions
  disabled: boolean
}) {
  const t = useMobileTranslation()
  const { current } = steps
  const decision = shape.decisions[current]!
  const held = steps.held[current] ?? null
  const typed = held !== null && !decision.replies.some((reply) => reply.label === held)
  const folded = shape.decisions.flatMap((line, index) => {
    const words = index === current ? null : (answered[index] ?? steps.held[index])
    return words ? [{ line, index, words, reopens: !answered[index] }] : []
  })
  // One sentence, link included, so translators see it whole: the link sits between the tags.
  const heldLine = t(
    'bots.items.ask.heldCount',
    '{{count}} answers not sent yet, <send>send anyway</send>',
    {
      count: steps.heldCount,
      defaultValue_one: '{{count}} answer not sent yet, <send>send anyway</send>'
    }
  ).split(/<\/?send>/)
  return (
    <>
      {folded.length > 0 ? (
        <View style={styles.folded}>
          {folded.map(({ line, index, words, reopens }) => (
            <MobileBotItemAnswerLine
              key={line.question}
              question={line.question}
              words={words}
              onPress={reopens ? () => steps.go(index) : undefined}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.head}>
        <View style={styles.question}>
          <MobileMarkdown
            content={decision.question}
            tone="strong"
            rangeSelectable={INLINE_TEXT_SELECTION}
          />
        </View>
        <StepNav steps={steps} />
      </View>
      <View style={styles.chips}>
        {decision.replies.map((reply) => (
          <MobileBotItemChip
            key={reply.label}
            reply={reply}
            picked={held === reply.label}
            // Filled until the owner picks one on this line; then the pick stands out instead.
            filled={reply.recommended === true && held === null}
            disabled={disabled}
            onPress={() => steps.answer(current, reply.label)}
          />
        ))}
        {typed ? (
          // Words held for this line: back into the box, whose send holds them again.
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            hitSlop={4}
            onPress={() => actions.edit(held)}
            style={({ pressed }) => [
              styles.chip,
              styles.chipPicked,
              disabled ? styles.disabled : pressed && pressedStyle
            ]}
          >
            <Pencil size={ICON} color={colors.textPrimary} />
            <Text style={styles.chipText}>{held}</Text>
          </Pressable>
        ) : (
          <MobileBotItemTypeAnswerChip disabled={disabled} onPress={actions.type} />
        )}
      </View>
      {steps.heldCount > 0 ? (
        <Text style={styles.heldLine}>
          {heldLine[0]}
          <Text
            accessibilityRole="button"
            onPress={disabled ? undefined : steps.sendHeld}
            style={styles.sendAnyway}
          >
            {heldLine[1] ?? ''}
          </Text>
          {heldLine[2] ?? ''}
        </Text>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 10 },
  // Half the single-line height: one line reads as a pill, a wrapped label as a rounded rectangle.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.choiceBorder
  },
  // The desktop's bg-foreground text-background: the one the owner most likely means.
  chipFilled: { borderColor: colors.textPrimary, backgroundColor: colors.textPrimary },
  chipPicked: { borderColor: colors.inputBorder, backgroundColor: colors.translucentFill },
  chipText: { flexShrink: 1, fontSize: 14, lineHeight: 18, color: colors.textPrimary },
  chipTextFilled: { color: colors.bgBase },
  chipTextMuted: { color: colors.textMuted },
  star: { fontSize: 11 },
  disabled: { opacity: feedback.disabledOpacity },
  answerLine: { fontSize: 13, lineHeight: 19, color: colors.textMuted },
  answerWords: { color: colors.textSecondary },
  folded: { gap: spacing.xs, marginBottom: spacing.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  question: { flex: 1, minWidth: 0 },
  nav: { flexDirection: 'row', alignItems: 'center', marginRight: -spacing.xs },
  arrow: { width: 26, height: 24, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  heldLine: { marginTop: spacing.md, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  sendAnyway: { color: colors.textPrimary, textDecorationLine: 'underline' }
}))
