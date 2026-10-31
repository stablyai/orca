import { themedStyleSheet } from '../theme/themed-styles'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const conversationStyles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  headerText: { flex: 1, gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  host: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  meta: { fontSize: typography.metaSize, color: colors.textMuted },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  searchField: { flex: 1 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm
  },
  sectionName: { flex: 1, gap: spacing.xs },
  projectTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  newChat: {
    minHeight: 44,
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  actionText: { color: colors.textPrimary, fontSize: typography.bodySize },
  disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radii.control },
  rowButton: {
    flex: 1,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.sm
  },
  rowText: { flex: 1, gap: spacing.xs },
  rowTitle: { fontSize: typography.bodySize, color: colors.textPrimary },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  notice: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  failure: { color: colors.statusRed },
  empty: { color: colors.textMuted, fontSize: typography.bodySize, paddingVertical: spacing.md },
  drawer: { padding: spacing.lg, gap: spacing.md },
  detail: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20 },
  agentButton: {
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 48,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.control
  },
  spinner: { marginVertical: spacing.lg }
}))
