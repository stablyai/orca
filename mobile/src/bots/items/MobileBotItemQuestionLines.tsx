// A Needs you comment's question footer on the phone, as on desktop: under the body, each question line
// (an orange dot while the item waits on it) with its quick replies, and Type your answer. A quick reply
// posts its words as the owner's comment; a long press puts them in the comment box to add to first.
// Answered, the lines go muted and keep only the reply picked.
import { Pressable, Text, View } from 'react-native'
import { Check, Pencil } from 'lucide-react-native'
import {
  botItemPickedReplies,
  botItemQuickReplyText,
  type BotItemQuestionShape,
  type BotItemQuickReply
} from '../../../../src/shared/bots/bot-item-ask'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export type MobileBotItemQuickReplyActions = {
  send: (text: string) => void
  edit: (text: string) => void
  type: () => void
}

function ChipWords({ reply, muted = false }: { reply: BotItemQuickReply; muted?: boolean }) {
  const t = useMobileTranslation()
  return (
    <Text style={[styles.chipText, muted && styles.muted]}>
      {reply.label}
      {reply.recommended ? (
        <Text style={styles.recommended}>
          {'  '}
          {t('bots.items.ask.recommended', 'Recommended')}
        </Text>
      ) : null}
    </Text>
  )
}

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []

export function MobileBotItemQuestionLines({
  shape,
  waiting,
  answers = NO_ANSWERS,
  busy = false,
  actions
}: {
  shape: BotItemQuestionShape
  waiting: boolean
  answers?: readonly (BotItemEvent | null)[]
  /** A reply is on its way or just landed: the quick replies wait for its outcome. */
  busy?: boolean
  actions?: MobileBotItemQuickReplyActions
}) {
  const t = useMobileTranslation()
  return (
    <View style={[styles.footer, shape.body.trim() ? styles.spaced : null]}>
      {shape.decisions.map((decision, index) => {
        const answer = answers[index] ?? null
        const open = waiting && !answer
        const picks = answer ? (botItemPickedReplies(shape, answer.data)[index] ?? []) : []
        return (
          <View key={decision.question} style={styles.decision}>
            <View>
              {/* Hangs in the gutter, so the question and its chips share the body's left edge. */}
              {open ? <View style={styles.dot} /> : null}
              <Text style={[styles.question, !open && styles.muted]}>{decision.question}</Text>
            </View>
            {open && actions && decision.replies.length > 0 ? (
              <View style={styles.chips}>
                {decision.replies.map((reply) => {
                  const text = botItemQuickReplyText(shape, decision, reply)
                  return (
                    <Pressable
                      key={reply.label}
                      accessibilityRole="button"
                      accessibilityHint={reply.detail}
                      disabled={busy}
                      onPress={() => actions.send(text)}
                      onLongPress={() => actions.edit(text)}
                      style={({ pressed }) => [styles.chip, (pressed || busy) && styles.pressed]}
                    >
                      <ChipWords reply={reply} />
                    </Pressable>
                  )
                })}
                <Pressable
                  accessibilityRole="button"
                  onPress={actions.type}
                  style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                >
                  <Pencil size={12} color={colors.textMuted} />
                  <Text style={[styles.chipText, styles.muted]}>
                    {t('bots.items.ask.typeAnswer', 'Type your answer')}
                  </Text>
                </Pressable>
              </View>
            ) : picks.length > 0 ? (
              <View style={styles.chips}>
                {picks.map((pick) => (
                  <View key={pick.label} style={[styles.chip, styles.picked]}>
                    <Check size={12} color={colors.textMuted} />
                    <ChipWords reply={pick} muted />
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  footer: { gap: spacing.md },
  spaced: { marginTop: spacing.lg },
  dot: {
    position: 'absolute',
    left: -12,
    top: 7.5,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.agentQuestion
  },
  decision: { gap: spacing.md },
  question: { fontSize: 15, lineHeight: 21, fontWeight: '500', color: colors.textPrimary },
  muted: { color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.choiceBorder
  },
  picked: { backgroundColor: colors.translucentFill },
  pressed: { opacity: 0.6 },
  chipText: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textPrimary },
  recommended: { fontSize: typography.metaSize, color: colors.textMuted }
}))
