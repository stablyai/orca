import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

// Informational, not an error: the host is healthy and the user's target simply went away,
// so this stays monochrome rather than borrowing the auth-failed red.
export function HostRouteNoticeBanner({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}) {
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{message}</Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('hostRouteNotice.dismiss')}
        hitSlop={spacing.sm}
        style={styles.dismiss}
      >
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
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
  text: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  dismiss: { padding: spacing.xs }
})
