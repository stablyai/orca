// A reply's quote of the question it answers: one muted line above its text; a tap shows the question.
import { Pressable, Text, View } from 'react-native'
import { CornerDownRight } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { pressedStyle, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

export function MobileBotItemReplyQuote({
  text,
  onShowQuestion
}: {
  text: string
  /** Null while the question isn't in the Activity read so far. */
  onShowQuestion: (() => void) | null
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const line = (
    <>
      <CornerDownRight size={11} color={colors.textMuted} />
      <Text style={styles.text} numberOfLines={1}>
        {t('bots.items.comment.replyingTo', 'Replying to:')}{' '}
        <Text style={styles.question}>{text}</Text>
      </Text>
    </>
  )
  if (!onShowQuestion) {
    return <View style={styles.row}>{line}</View>
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && pressedStyle]}
      onPress={onShowQuestion}
      accessibilityRole="button"
      accessibilityLabel={t(
        'bots.items.activity.replyingTo',
        'Replying to: {{question}}. Go to the question',
        { question: text.slice(0, 80) }
      )}
      hitSlop={6}
    >
      {line}
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  text: { flexShrink: 1, fontSize: typography.metaSize, color: colors.textMuted },
  question: { color: colors.textSecondary, fontWeight: '500' }
}))
