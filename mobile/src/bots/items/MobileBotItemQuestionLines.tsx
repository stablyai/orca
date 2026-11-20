// A Needs you comment's question footer on the phone, as on desktop: under a hairline, "Needs you" while
// the item waits on it, each question line with its quick replies, and Type your answer. A quick reply
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

export function MobileBotItemQuestionLines({
  shape,
  waiting,
  answeredBy,
  actions
}: {
  shape: BotItemQuestionShape
  waiting: boolean
  answeredBy?: BotItemEvent
  actions?: MobileBotItemQuickReplyActions
}) {
  const t = useMobileTranslation()
  const picked = !waiting && answeredBy ? botItemPickedReplies(shape, answeredBy.data) : []
  return (
    <View style={[styles.footer, shape.body.trim() ? styles.divided : null]}>
      {waiting ? (
        <View style={styles.label}>
          <View style={styles.dot} />
          <Text style={styles.labelText}>{t('bots.items.activity.needsYou', 'Needs you')}</Text>
        </View>
      ) : null}
      {shape.decisions.map((decision, index) => {
        const pick = decision.replies.find((reply) => reply.label === picked[index])
        return (
          <View key={decision.question} style={styles.decision}>
            <Text style={[styles.question, !waiting && styles.muted]}>{decision.question}</Text>
            {waiting && actions ? (
              <View style={styles.chips}>
                {decision.replies.map((reply) => {
                  const text = botItemQuickReplyText(shape, decision, reply)
                  return (
                    <Pressable
                      key={reply.label}
                      accessibilityRole="button"
                      accessibilityHint={reply.detail}
                      onPress={() => actions.send(text)}
                      onLongPress={() => actions.edit(text)}
                      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                    >
                      <ChipWords reply={reply} />
                    </Pressable>
                  )
                })}
                <Pressable
                  accessibilityRole="button"
                  onPress={actions.type}
                  style={({ pressed }) => [styles.chip, styles.typeChip, pressed && styles.pressed]}
                >
                  <Pencil size={12} color={colors.textMuted} />
                  <Text style={[styles.chipText, styles.muted]}>
                    {t('bots.items.ask.typeAnswer', 'Type your answer')}
                  </Text>
                </Pressable>
              </View>
            ) : pick ? (
              <View style={styles.chips}>
                <View style={styles.chip}>
                  <Check size={12} color={colors.textMuted} />
                  <ChipWords reply={pick} muted />
                </View>
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
  divided: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  label: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: -spacing.sm },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.agentQuestion },
  labelText: { fontSize: typography.metaSize, color: colors.agentQuestion },
  decision: { gap: 6 },
  question: { fontSize: 15, lineHeight: 21, fontWeight: '500', color: colors.textPrimary },
  muted: { color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.choiceBorder
  },
  typeChip: { borderColor: 'transparent' },
  pressed: { opacity: 0.6 },
  chipText: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textPrimary },
  recommended: { fontSize: typography.metaSize, color: colors.textMuted }
}))
