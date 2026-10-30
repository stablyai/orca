import { Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

// Monochrome notice reports vanished target; failure uses one red rule for action refusal without taking screen.
// Announce inserted banners: failure uses alert/assertive, notice uses polite live region (RN has no status role).
export function HostRouteNoticeBanner({
  message,
  tone = 'notice',
  onDismiss
}: {
  message: string
  tone?: 'notice' | 'failure'
  onDismiss: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View
      style={[styles.banner, tone === 'failure' && styles.failure]}
      accessibilityRole={tone === 'failure' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'failure' ? 'assertive' : 'polite'}
    >
      <Text style={styles.text}>{message}</Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('components.hostRouteNoticeBanner.dismissNotice', 'Dismiss notice')}
        hitSlop={spacing.sm}
        style={styles.dismiss}
      >
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  failure: { borderBottomColor: colors.statusRed },
  text: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  dismiss: { padding: spacing.xs }
}))
