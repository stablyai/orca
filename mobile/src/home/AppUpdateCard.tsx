import { ArrowUpFromLine, X } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function AppUpdateCard(props: {
  version: string
  onPress: () => void
  onDismiss: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const title = t('home.appUpdateCard.title', 'Orca {{version}} is available', {
    version: props.version
  })
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          'home.appUpdateCard.updateAccessibilityLabel',
          'Orca {{version}} is available, tap to update',
          { version: props.version }
        )}
        style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
        onPress={props.onPress}
      >
        <ArrowUpFromLine size={20} color={colors.accentBlue} />
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.updateButton}>
          <Text style={styles.updateLabel}>{t('home.appUpdateCard.update', 'Update')}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          'home.appUpdateCard.dismissAccessibilityLabel',
          'Dismiss Orca {{version}} update',
          { version: props.version }
        )}
        hitSlop={8}
        style={({ pressed }) => [styles.dismissButton, pressed && styles.dismissPressed]}
        onPress={props.onDismiss}
      >
        <X size={17} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 26,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingVertical: spacing.md
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  title: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  updateButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  updateLabel: { color: colors.accentBlue, fontSize: 15, fontWeight: '600' },
  dismissButton: {
    width: 40,
    height: 40,
    marginHorizontal: spacing.xs,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dismissPressed: { backgroundColor: colors.bgRaised }
}))
