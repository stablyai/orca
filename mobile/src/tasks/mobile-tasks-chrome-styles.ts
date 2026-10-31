import { themedStyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksChromeStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgBase
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  providerSwitch: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  // At least the screen's width, so chips that fit stretch to fill it.
  toolbar: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  filterSheetHeader: {
    marginHorizontal: -spacing.sm,
    marginBottom: spacing.xs
  },
  filterFootnote: {
    fontSize: 12,
    color: colors.textMuted,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.sm
  },
  errorBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  errorText: {
    color: colors.statusRed,
    fontSize: 13
  },
  sourceErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceErrorCopy: {
    flex: 1,
    minWidth: 0
  },
  sourceErrorText: {
    color: colors.statusAmber,
    fontSize: 13,
    fontWeight: '600'
  },
  sourceErrorSlug: {
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  sourceErrorMessage: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  },
  sourceErrorRetry: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sourceErrorRetryText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  sourceNoticeBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceNoticeText: {
    color: colors.statusAmber,
    fontSize: 13
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  centeredHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    maxWidth: 280,
    textAlign: 'center'
  },
  centerActionButton: {
    marginTop: spacing.md,
    minWidth: 160
  },
  list: {
    paddingTop: spacing.xs
  },
  repoSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgBase
  },
  repoSectionDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  repoSectionTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 26,
    marginRight: spacing.lg
  }
}))
