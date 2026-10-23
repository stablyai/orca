import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { diffStyles } from './mobile-source-control-diff-styles'
import { listStyles } from './mobile-source-control-list-styles'

// Hub chrome, the branch header and the Changes controls above the list.
const baseStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  // Sits over the NavBar's empty leading slot: the dock closes rather than goes back.
  embeddedClose: {
    position: 'absolute',
    left: spacing.xs,
    top: 4
  },
  branchHeader: {
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md
  },
  branchHeaderText: {
    paddingHorizontal: spacing.lg + 4,
    gap: 2
  },
  branchLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  branchText: {
    ...textStyles.body,
    fontWeight: '500',
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  countText: {
    ...textStyles.subhead,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  conflictBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.group,
    backgroundColor: 'rgba(245, 158, 11, 0.1)'
  },
  conflictText: {
    ...textStyles.callout,
    fontWeight: '500',
    flex: 1,
    minWidth: 120,
    color: colors.textPrimary
  },
  createPrBlock: {
    marginHorizontal: spacing.lg,
    gap: spacing.xs
  },
  createPrHint: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg
  }
})

export const styles = { ...baseStyles, ...listStyles, ...diffStyles }
