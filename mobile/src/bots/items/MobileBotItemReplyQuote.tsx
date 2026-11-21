// A reply's quote of the question it answers: one muted line above its text.
import { Text, View } from 'react-native'
import { CornerDownRight } from '../../components/icons/app-icons'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export function MobileBotItemReplyQuote({ text }: { text: string }) {
  const t = useMobileTranslation()
  return (
    <View style={styles.row}>
      <CornerDownRight size={11} color={colors.textMuted} />
      <Text style={styles.text} numberOfLines={1}>
        {t('bots.items.comment.replyingTo', 'Replying to:')}{' '}
        <Text style={styles.question}>{text}</Text>
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  text: { flexShrink: 1, fontSize: typography.metaSize, color: colors.textMuted },
  question: { color: colors.textSecondary, fontWeight: '500' }
}))
