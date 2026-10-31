import { StyleSheet } from 'react-native'
import { colors, spacing, typography, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
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
    borderRadius: radii.surface,
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
  // Reserve trailing width so selected checkmark cannot squeeze active usage bars relative to other rows.
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
}))
