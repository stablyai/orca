import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { styles as accountsStyles } from '../accounts/mobile-accounts-screen-styles'

// The Accounts screen's frame (header, sections, cards, rows), plus the machine row's own parts.
export const styles = StyleSheet.create({
  ...accountsStyles,
  rowTrailing: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: spacing.sm
  },
  rowStale: {
    opacity: 0.6
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  stateDot: {
    width: 7,
    height: 7,
    borderRadius: 4
  },
  stateText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  actionButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    minWidth: 64,
    alignItems: 'center'
  },
  actionButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  providerFailure: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    marginBottom: spacing.sm
  }
})
