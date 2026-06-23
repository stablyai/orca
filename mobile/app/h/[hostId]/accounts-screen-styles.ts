import { StyleSheet } from 'react-native'
import { colors, spacing, typography, radii } from '../../../src/theme/mobile-theme'

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  titleWrap: {
    flex: 1
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  subheading: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    marginTop: 1
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  section: {
    marginBottom: spacing.xl
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  sectionHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowMain: {
    flex: 1,
    gap: 4
  },
  // Why: fixed-width trailing slot so the usage bars in `rowMain` keep the
  // same width whether or not the row is currently selected (otherwise the
  // checkmark on the active account squeezes the bars narrower than the
  // inactive rows above/below it).
  rowTrailing: {
    width: 24,
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: spacing.sm
  },
  rowTitle: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSubtitle: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  usageRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 4
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed
  },
  placeholder: {
    paddingVertical: spacing.xl * 2,
    alignItems: 'center',
    gap: spacing.sm
  },
  placeholderText: {
    fontSize: typography.bodySize,
    color: colors.textSecondary
  },
  footerHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm
  },
  footerHintText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
})
