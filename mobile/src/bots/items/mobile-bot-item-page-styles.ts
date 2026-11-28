import { colors, spacing, typography, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  hidden: { display: 'none' },
  // As chat caps its card: the activity stays in view and a tall card scrolls inside.
  askDock: { flexShrink: 1, minHeight: 0, maxHeight: '60%' },
  // The card's own inset is the chat's screen edge; here the page already has one, so its edge meets the groups'.
  askSlot: { flexShrink: 1, minHeight: 0, marginHorizontal: -spacing.sm },
  scroll: { flex: 1 },
  content: { gap: spacing.sm, paddingBottom: spacing.lg },
  head: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  number: { fontWeight: '400', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  note: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  },
  noteText: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  noteBody: { color: colors.textPrimary },
  value: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 180 },
  valueText: { fontSize: 15, color: colors.textSecondary, flexShrink: 1 },
  doneMeans: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    gap: 2
  },
  doneMeansLabel: { fontSize: 13, color: colors.textMuted },
  doneMeansText: { fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  missing: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  missingTitle: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  missingBody: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg
  }
}))
