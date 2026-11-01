import { Share, X } from 'lucide-react-native'
import { Text, View, Pressable } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { takeIncomingShare, type IncomingShare } from '../share/incoming-share'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Home doubles as the share destination picker; this says why the user landed here.
export function MobileHomeShareCard({ share }: { share: IncomingShare }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const preview = [share.text.split('\n', 1)[0], ...share.files.map((file) => file.name)]
    .filter(Boolean)
    .join(', ')
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Share size={20} color={colors.accentBlue} />
      <View style={styles.text}>
        <Text style={styles.title}>
          {t('home.shareCard.title', 'Open a workspace chat to add this')}
        </Text>
        <Text style={styles.preview} numberOfLines={2}>
          {preview}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('home.shareCard.cancel', 'Cancel share')}
        hitSlop={8}
        style={({ pressed }) => [styles.dismissButton, pressed && styles.dismissPressed]}
        onPress={() => takeIncomingShare()}
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
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingLeft: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  preview: { color: colors.textSecondary, fontSize: 15, lineHeight: 20, marginTop: 2 },
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
