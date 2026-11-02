import { View, Text } from 'react-native'
import { SquareTerminal } from 'lucide-react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

// Wide tablet/foldable detail stays empty beside list until workspace opens.
export function WorkspaceDetailPlaceholder() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.container}>
      <View style={styles.icon}>
        <SquareTerminal size={28} color={colors.textMuted} />
      </View>
      <Text style={styles.title}>
        {t('components.workspaceDetailPlaceholder.title', 'No workspace open')}
      </Text>
      <Text style={styles.body}>
        {t(
          'components.workspaceDetailPlaceholder.description',
          'Pick a workspace from the sidebar to open its terminal here.'
        )}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.bgBase
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: radii.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel,
    marginBottom: spacing.lg
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: spacing.xs
  },
  body: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 320
  }
}))
