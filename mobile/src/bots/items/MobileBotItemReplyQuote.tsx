// A recorded answer's quote of the question it answers: one muted line above the answer's text.
import { Text, View } from 'react-native'
import { CornerDownRight } from 'lucide-react-native'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export function MobileBotItemReplyQuote({ text }: { text: string }) {
  return (
    <View style={styles.row}>
      <CornerDownRight size={11} color={colors.textMuted} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
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
  text: { flexShrink: 1, fontSize: typography.metaSize, color: colors.textMuted }
}))
