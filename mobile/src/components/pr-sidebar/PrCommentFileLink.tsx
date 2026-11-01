import { Pressable, Text } from 'react-native'
import { FileText } from 'lucide-react-native'
import { colors, pressedStyle, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// A comment's file:line as a quiet mono link.
export function PrCommentFileLink({
  location,
  onPress
}: {
  location: string
  onPress?: () => void
}) {
  useMobileColorScheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={4}
      accessibilityRole={onPress ? 'link' : undefined}
      style={({ pressed }) => [styles.file, pressed && pressedStyle]}
    >
      <FileText size={12} color={colors.textMuted} strokeWidth={2} />
      <Text style={styles.fileText} numberOfLines={1}>
        {location}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%'
  },
  fileText: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    flexShrink: 1
  }
}))
