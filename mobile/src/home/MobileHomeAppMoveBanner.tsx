import { ChevronRight } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { openAppMoveScreen, playStoreAvailable } from '../app-move/app-move-gate'
import { isRetiredGithubAndroidApp } from '../app-update/app-update-runtime'
import { OrcaLogo } from '../components/OrcaLogo'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** Not dismissible: the retired GitHub app gets no more updates, so Home keeps pointing at the new one. */
export function MobileHomeAppMoveBanner() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  if (!isRetiredGithubAndroidApp) {
    return null
  }
  const title = playStoreAvailable
    ? t('appMove.play.title', 'Orca is now on Google Play')
    : t('appMove.download.title', 'Get the new Orca app')
  const link = t('appMove.banner.seeHowToSwitch', 'See how to switch')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${link}`}
      style={({ pressed }) => [styles.banner, pressed && styles.bannerPressed]}
      onPress={openAppMoveScreen}
    >
      <View style={styles.tile}>
        <OrcaLogo size={18} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.link}>{link}</Text>
      </View>
      <ChevronRight size={20} color={colors.textSecondary} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    paddingVertical: spacing.md,
    paddingLeft: 14,
    paddingRight: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  bannerPressed: { backgroundColor: colors.bgRaised },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.textPrimary },
  link: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: colors.accentBlue, marginTop: 1 }
}))
