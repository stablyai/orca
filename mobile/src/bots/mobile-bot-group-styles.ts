import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
export const groupStyles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.md },
  title: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  inset: { padding: spacing.md },
  picture: { alignItems: 'center', paddingTop: spacing.md },
  suggestion: { paddingTop: spacing.sm },
  members: { maxHeight: 256, paddingHorizontal: spacing.md, marginBottom: spacing.md },
  notice: { color: colors.textSecondary, fontSize: typography.metaSize, padding: spacing.md },
  turn: { paddingVertical: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  transcript: { paddingVertical: spacing.md },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  grow: { flex: 1 },
  centered: { textAlign: 'center' }
}))
