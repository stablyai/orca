import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

export const prCreateEmptyStateStyles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  header: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  headerLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  createButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.bgBase,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  iconButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  body: {
    padding: spacing.md,
    gap: spacing.sm
  },
  bodyTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  bodyText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  composerArea: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    padding: spacing.md
  }
})
