import { StyleSheet, colors, spacing, textStyles } from './mobile-tasks-dependencies'

export const mobileTasksChromeStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  page: {
    flex: 1
  },
  pageHeader: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs
  },
  largeTitleSubtitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: textStyles.footnote.lineHeight
  },
  largeTitleSubtitleText: {
    ...textStyles.footnote,
    flexShrink: 1,
    color: colors.textSecondary
  },
  providerSwitch: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  toolbarScroll: {
    marginTop: spacing.xs,
    flexGrow: 0
  },
  segmentRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  searchBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  bannerStack: {
    gap: spacing.sm,
    paddingTop: spacing.sm
  },
  refreshingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingTop: spacing.md
  },
  refreshingText: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statePage: {
    flexGrow: 1
  },
  stateBody: {
    flex: 1,
    minHeight: 320
  },
  emptyText: {
    ...textStyles.callout,
    color: colors.textSecondary
  },
  centeredHint: {
    ...textStyles.footnote,
    color: colors.textMuted,
    marginTop: spacing.sm,
    maxWidth: 280,
    textAlign: 'center'
  },
  list: {
    paddingTop: 0
  },
  repoSectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: spacing.lg
  }
})
