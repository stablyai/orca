import { colors, feedback, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const mobileSessionTabStripStyles = themedStyleSheet(() => ({
  bar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  barInTopBar: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'stretch',
    marginVertical: -spacing.xs,
    marginLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  scrollFrame: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'stretch'
  },
  scroll: {
    flex: 1,
    maxHeight: 44,
    backgroundColor: colors.bgPanel
  },
  scrollInTopBar: {
    alignSelf: 'stretch',
    maxHeight: 44
  },
  scrollContent: {
    paddingLeft: spacing.md,
    paddingRight: spacing.sm
  },
  scrollContentInTopBar: {
    paddingLeft: 0
  },
  tab: {
    minWidth: 44,
    maxWidth: 128,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  tabFirst: {
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  tabActive: {
    borderBottomColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  tabPressed: {
    backgroundColor: colors.translucentFill
  },
  tabLabelRow: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  tabIcon: {
    flexShrink: 0
  },
  tabText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: 13
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  edgeHint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.bgPanel
  },
  edgeHintLeft: {
    left: 0,
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  edgeHintRight: {
    right: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  sideCell: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  lastCell: {
    borderRightWidth: 0
  },
  cellPressed: {
    backgroundColor: colors.translucentFill
  },
  cellDisabled: {
    opacity: feedback.disabledOpacity
  }
}))
