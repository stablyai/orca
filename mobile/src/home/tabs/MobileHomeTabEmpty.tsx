import type { AppIcon } from '../../components/icons/app-icons'
import { Text, View } from 'react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

/** A Home tab with nothing to list: its glyph, a title and a line. */
export function MobileHomeTabEmpty(props: { icon: AppIcon; title: string; message?: string }) {
  useMobileColorScheme()
  const Icon = props.icon
  return (
    <View style={styles.empty}>
      <Icon size={30} strokeWidth={1.6} color={colors.textMuted} />
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {props.title}
      </Text>
      {props.message ? <Text style={styles.emptyBody}>{props.message}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32,
    gap: spacing.sm
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  emptyBody: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }
}))
