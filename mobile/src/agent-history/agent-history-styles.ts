import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  scopeTabs: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm
  },
  groupHeaderText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  groupHeaderCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  cardPressed: {
    backgroundColor: colors.bgRaised
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  cardTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  cardTimeAgo: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  cardLastMessage: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs
  },
  cardMetaText: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  currentBadge: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  currentBadgeText: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  resumeButton: {
    minHeight: 28,
    minWidth: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radii.control
  },
  resumeButtonPressed: {
    opacity: 0.78
  },
  resumeButtonDisabled: {
    opacity: 0.45
  },
  preview: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    gap: spacing.sm
  },
  previewTurn: {
    gap: 2
  },
  previewRole: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  previewText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  noticeBanner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  noticeText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize
  },
  resumeBanner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  resumeBannerText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm
  },
  stateTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  retryButton: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
