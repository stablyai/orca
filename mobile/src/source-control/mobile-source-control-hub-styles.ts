import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Styles for the hub's segmented control and the branch-card PR chip. Split from
// mobile-source-control-styles.ts so neither file crosses the line limit.
export const hubStyles = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: 3,
    borderRadius: radii.button + 2,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: 2
  },
  segment: {
    flex: 1,
    minHeight: 34,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs
  },
  segmentActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  segmentPressed: {
    opacity: 0.7
  },
  segmentText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  segmentTextActive: {
    color: colors.textPrimary
  },
  // The PR chip sits below the count row inside the branch card, separated by a
  // hairline so it reads as a distinct, tappable status line.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  chipPressed: {
    opacity: 0.7
  },
  chipIcon: {
    width: 18,
    alignItems: 'center'
  },
  chipNumber: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  statePill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth
  },
  statePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  rollup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  rollupText: {
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  comment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  commentText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  // Pushes the chevron to the trailing edge without a fixed-width spacer.
  chipSpacer: {
    flex: 1,
    minWidth: spacing.sm
  },
  chipCreateText: {
    color: colors.accentBlue,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  chipMutedText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  // Wraps the Changes-only controls (commit-failure/error notice, create-PR entry,
  // bulk Stage/Unstage row) that used to live inside the summary card, now that the
  // card is shared across segments and holds only branch status.
  changesControls: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs
  },
  // Fills the remaining space below the header/segments/card so each segment's
  // scroll view (SectionList / PR sidebar / history list) expands and scrolls.
  tabBody: {
    flex: 1
  },
  // Keep a previously-visited segment mounted (scroll + fetch state) without
  // participating in layout while another segment is active.
  tabBodyHidden: {
    display: 'none'
  }
})
