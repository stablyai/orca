// What a Waiting item waits on, last in its Activity: the comment card's surface with the Waiting
// glyph, the text and when it was set, and nothing to answer. As the desktop draws it.
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileMessageTime } from '../../session/native-chat/transcript/messages/use-mobile-message-time'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'

export function MobileBotItemWaitCard({ text, at }: { text: string; at: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const time = useMobileMessageTime()
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.icon}>
          <MobileBotItemStatusIcon status="waiting" size={12} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {t('bots.items.activity.waitingOn', 'Waiting on')}
        </Text>
        <View style={styles.spacer} />
        <Text style={styles.meta} accessibilityLabel={time.full(at)}>
          {time.label(at)}
        </Text>
      </View>
      <Text style={styles.text}>{text}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  icon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  title: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  spacer: { flex: 1 },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  text: { fontSize: 15, lineHeight: 21, color: colors.textPrimary }
}))
