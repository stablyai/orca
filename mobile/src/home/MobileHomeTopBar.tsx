import { Settings } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { OrcaLogo } from '../components/OrcaLogo'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileHomeTopBar({
  onOpenSettings,
  showBrand = true
}: {
  onOpenSettings: () => void
  /** First run draws the logo large below, so the bar keeps only Settings. */
  showBrand?: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.topBar}>
      {showBrand ? (
        <View style={styles.brandLockup}>
          <View style={styles.logoMark}>
            <OrcaLogo size={19} />
          </View>
          <Text style={styles.brandName}>Orca</Text>
        </View>
      ) : (
        <View />
      )}
      <Pressable
        style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
        onPress={onOpenSettings}
        accessibilityRole="button"
        accessibilityLabel={t('common.settings', 'Settings')}
      >
        <Settings size={22} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.lg + spacing.xs,
    paddingRight: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs
  },
  brandLockup: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  logoMark: { marginRight: spacing.sm },
  brandName: { color: colors.textPrimary, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: { backgroundColor: colors.bgRaised }
}))
