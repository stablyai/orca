// A Needs you comment's question footer on the phone: under the body, each question line (Markdown, an
// orange dot while the item waits on it). The ask card docked under the activity answers it. Answered,
// the lines go muted and keep only the replies picked.
import { Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  botItemPickedReplies,
  type BotItemQuestionShape
} from '../../../../src/shared/bots/bot-item-ask'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []

export function MobileBotItemQuestionLines({
  shape,
  waiting,
  answers = NO_ANSWERS
}: {
  shape: BotItemQuestionShape
  waiting: boolean
  answers?: readonly (BotItemEvent | null)[]
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
              {/* Hangs in the gutter, so the question shares the body's left edge. */}
              {open ? <View style={styles.dot} /> : null}
              <MobileMarkdown content={decision.question} tone={open ? 'medium' : 'muted'} />
            </View>
            {picks.length > 0 ? (
              <View style={styles.chips}>
                {picks.map((pick) => (
                  <View key={pick.label} style={styles.chip}>
                    <Check size={12} color={colors.textMuted} />
                    <Text style={styles.chipText}>
                      {pick.label}
                      {pick.recommended ? (
                        <Text style={styles.recommended}>
                          {'  '}
                          {t('bots.items.ask.recommended', 'Recommended')}
                        </Text>
                      ) : null}
                    </Text>
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
    borderColor: colors.choiceBorder,
    backgroundColor: colors.translucentFill
  },
  chipText: { fontSize: typography.bodySize, lineHeight: 20, color: colors.textMuted },
  recommended: { fontSize: typography.metaSize, color: colors.textMuted }
}))
