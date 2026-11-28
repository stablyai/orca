import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  event: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.xs
  },
  eventIcon: { width: 16, height: 18, alignItems: 'center', justifyContent: 'center' },
  eventBody: { flex: 1, minWidth: 0 },
  line: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  none: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  actor: { fontWeight: '500', color: colors.textSecondary },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  chevronClosed: { transform: [{ rotate: '-90deg' }] },
  diff: {
    marginTop: 2,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    gap: 2
  },
  removed: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textDecorationLine: 'line-through'
  },
  added: { fontSize: 13, lineHeight: 18, color: colors.textPrimary },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
