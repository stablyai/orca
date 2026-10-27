import { ChevronRight } from 'lucide-react-native'
import { Pressable, Text } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function HostDiagnosticsLink({ onPress }: { onPress: () => void }): React.JSX.Element {
  useMobileColorScheme()
  return (
    <Pressable
      style={styles.link}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="View network diagnostics"
    >
      <Text style={styles.text}>View network diagnostics</Text>
      <ChevronRight size={16} color={colors.textSecondary} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  link: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  text: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
