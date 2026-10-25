import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const hostScreenSecondaryStyles = StyleSheet.create({
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionRepoIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  sectionCount: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: spacing.xs
  },
  sectionPendingSpinner: {
    marginLeft: spacing.sm
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  },
  filterModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  filterModalHeading: {
    flexShrink: 1
  },
  filterModalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  filterModalSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2
  },
  optionPending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  clearFiltersText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  filterGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: spacing.md
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    gap: spacing.sm
  },
  filterRowText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  filterSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  optionRowLabel: {
    flex: 1
  },
  optionRowDetail: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2
  },
  optionRowIndented: {
    paddingLeft: spacing.md + 2 + spacing.lg
  },
  optionRowDisabled: {
    opacity: 0.5
  },
  optionSearch: {
    padding: spacing.sm
  },
  optionRowValue: {
    flexShrink: 1,
    maxWidth: '45%',
    fontSize: 13,
    color: colors.textMuted
  },
  // On the drawer's base color, so the track takes the panel color the option cards use.
  optionSegmented: {
    backgroundColor: colors.bgPanel,
    marginBottom: spacing.md
  },
  optionBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs
  },
  optionBackText: {
    fontSize: 14,
    color: colors.textSecondary
  },
  optionPageTitle: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  filterRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  confirmContent: {
    paddingBottom: spacing.lg
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  confirmMessage: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: 10,
    alignItems: 'center'
  },
  confirmBtnCancel: {
    backgroundColor: colors.bgPanel
  },
  confirmBtnDestructive: {
    backgroundColor: colors.statusRed
  },
  confirmBtnPressed: {
    opacity: 0.7
  },
  confirmBtnCancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  confirmBtnDestructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
})
