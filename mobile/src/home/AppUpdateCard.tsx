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
        <View style={styles.icon}>
          <ArrowUpFromLine size={20} strokeWidth={1.75} color={colors.textPrimary} />
        </View>
        <View style={styles.main}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t('home.appUpdateCard.updateHint', 'Tap to update')}
          </Text>
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
        <X size={16} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingVertical: 12
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  subtitle: { color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
  dismissButton: {
    width: 40,
    height: 40,
    marginHorizontal: spacing.xs,
    borderRadius: radii.row,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dismissPressed: { backgroundColor: colors.bgRaised }
}))
