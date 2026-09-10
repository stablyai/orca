import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const mobileMaestroHumanReviewStyles = StyleSheet.create({
  section: { gap: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7
  },
  count: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 12,
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center'
  },
  statePanel: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    gap: spacing.sm
  },
  stateTitle: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17 },
  retry: {
    minHeight: 40,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  retryText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
  reviewRow: {
    minHeight: 54,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  reviewText: { flex: 1, gap: 2 },
  reviewTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  reviewSummary: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700'
  },
  detail: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    gap: spacing.md
  },
  detailTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  detailTitle: { flex: 1, color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  group: { gap: spacing.sm },
  groupTitle: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '700' },
  referenceRow: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    gap: 2
  },
  referenceTitle: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' },
  referenceMeta: { color: colors.textMuted, fontSize: 10 },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    textAlignVertical: 'top'
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: {
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  actionText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
  primaryAction: { backgroundColor: colors.surfaceBright, borderColor: colors.surfaceBright },
  primaryActionText: { color: colors.bgBase },
  disabled: { opacity: 0.4 },
  actionError: { color: colors.statusRed, fontSize: typography.metaSize },
  receipt: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    gap: spacing.xs
  },
  receiptTitle: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
  receiptText: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17 },
  technicalButton: { minHeight: 40, justifyContent: 'center' },
  technicalLabel: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600' },
  technicalValue: { color: colors.textMuted, fontSize: 10, fontFamily: typography.monoFamily }
})
