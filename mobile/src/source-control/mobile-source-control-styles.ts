import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { diffStyles } from './mobile-source-control-diff-styles'
import { listStyles } from './mobile-source-control-list-styles'

const baseStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700'
  },
  meta: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  refreshButton: {
    width: 36,
    height: 36,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs
  },
  refreshButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  refreshButtonDisabled: {
    opacity: 0.45
  },
  summaryCard: {
    margin: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  branchLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  branchText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  syncText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  countRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  countText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  conflictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  conflictText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    textTransform: 'capitalize'
  },
  abortButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.statusAmber
  },
  abortPressed: {
    backgroundColor: colors.bgRaised
  },
  abortText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'capitalize'
  },
  actionError: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed
  },
  actionErrorText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  bulkRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  bulkButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs
  },
  bulkMenuButton: {
    width: 42,
    minHeight: 36,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bulkButtonDisabled: {
    opacity: 0.45
  },
  bulkButtonPressed: {
    opacity: 0.75
  },
  bulkButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})

export const styles = { ...baseStyles, ...listStyles, ...diffStyles }
