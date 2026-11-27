import type { LucideIcon } from 'lucide-react-native'
import { Text, View } from 'react-native'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

/** A Home tab with nothing to list: its glyph, a title and a line. */
export function MobileHomeTabEmpty(props: {
  icon: LucideIcon
  title: string
  message?: string
  /** Centres in the space it is given, for a tab with nothing else on it but a foot. */
  centred?: boolean
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const Icon = props.icon
  return (
    <View style={[styles.empty, props.centred && styles.centred]}>
      <Icon size={30} strokeWidth={1.6} color={colors.textMuted} />
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {props.title}
      </Text>
      {props.message ? <Text style={styles.emptyBody}>{props.message}</Text> : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32,
    gap: spacing.sm
  },
  centred: { flex: 1, justifyContent: 'center', marginTop: 0 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  emptyBody: {
    maxWidth: 280,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    textAlign: 'center'
  }
}))
