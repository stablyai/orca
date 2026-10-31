import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const projectListStyles = themedStyleSheet(() => ({
  list: { paddingHorizontal: spacing.lg, paddingBottom: 96 },
  toolbar: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  chip: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  selected: { backgroundColor: colors.bgRaised },
  chipText: { fontSize: typography.metaSize, color: colors.textSecondary },
  title: { fontSize: typography.bodySize, color: colors.textPrimary, fontWeight: '600' },
  meta: { fontSize: typography.metaSize, color: colors.textSecondary, marginTop: spacing.xs },
  attention: { color: colors.statusAmber },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  category: {
    flex: 1,
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: typography.metaSize
  },
  count: { color: colors.textMuted, fontSize: typography.metaSize },
  row: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  project: { flexDirection: 'row', alignItems: 'center' },
  open: { flex: 1, minWidth: 0, paddingVertical: spacing.md, minHeight: 60 },
  expand: { width: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  sessions: {
    paddingLeft: spacing.md,
    paddingBottom: spacing.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  session: { paddingVertical: spacing.sm, minHeight: 48 },
  sessionTitle: { color: colors.textPrimary, fontSize: typography.bodySize },
  quiet: { minHeight: 44, justifyContent: 'center' },
  quietText: { color: colors.textSecondary, fontSize: typography.metaSize },
  empty: { padding: spacing.xl, color: colors.textSecondary, fontSize: typography.bodySize },
  shortcut: {
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.md,
    borderRadius: radii.surface,
    marginBottom: spacing.sm
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  host: { flex: 1, minWidth: 0 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  menu: {
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  menuRow: { minHeight: 44, justifyContent: 'center' }
}))
