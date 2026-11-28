import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

export const stylesSheet = themedStyleSheet((colors) => ({
  text: { flex: 1, minWidth: 0, marginLeft: spacing.xs },
  name: { color: colors.textPrimary, fontWeight: '600' },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
  meta: { color: colors.textMuted, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.statusRed },
  heading: { color: colors.textMuted, marginTop: spacing.xs },
  error: { color: colors.textPrimary },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingLeft: spacing.sm,
    gap: 2
  },
  quoteText: { color: colors.textPrimary },
  measure: { position: 'absolute', left: 0, right: 0, opacity: 0 },
  showAll: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  link: { color: colors.textSecondary, textDecorationLine: 'underline' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sendAgainError: { color: colors.statusRed }
}))
