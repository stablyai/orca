import { Settings } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { OrcaLogo } from '../components/OrcaLogo'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileHomeTopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.topBar}>
      <View style={styles.brandLockup}>
        <View style={styles.logoMark}>
          <OrcaLogo size={18} />
        </View>
        <Text style={styles.brandName}>Orca</Text>
      </View>
      <Pressable
        style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
        onPress={onOpenSettings}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.settings', 'Settings')}
      >
        <Settings size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  brandLockup: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  logoMark: { marginRight: spacing.sm },
  brandName: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: { backgroundColor: colors.bgRaised }
}))
