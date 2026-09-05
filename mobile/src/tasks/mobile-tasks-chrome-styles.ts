import { StyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksChromeStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    minHeight: 38,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center'
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2
  },
  toolbarScroll: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  segmentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs
  },
  segmentIconButton: {
    width: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  segmentCountPill: {
    minWidth: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm
  },
  segmentRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  segmentButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  segmentSecondaryText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  searchBar: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
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
    borderRadius: radii.button,
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
    borderRadius: 4
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
})
