import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../../../../src/theme/mobile-theme'

export const mobileSessionFrameStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  kavInner: {
    flex: 1
  },
  // Master-detail content row below the header chrome (KTD2): the existing content is
  // the flex-1 left child; the dock column (when present on wide) is the right child.
  sessionContentRow: {
    flex: 1,
    flexDirection: 'row'
  },
  sessionContentMain: {
    flex: 1,
    minWidth: 0
  },
  sessionChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sessionTopBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
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
  filesButton: {
    width: 36,
    height: 36,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs
  },
  filesButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  // Selected state for the active docked-panel icon on wide layouts (R2).
  filesButtonActive: {
    backgroundColor: colors.bgRaised
  },
  sessionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600'
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  sessionMetaText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  tabScroll: {
    flex: 1,
    maxHeight: 36
  },
  tabContent: {
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm
  },
  tab: {
    width: 128,
    maxWidth: 128,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    // Neutral grey underline, matching the desktop terminal tab's active
    // indicator (a muted foreground/card mix), not a blue accent.
    borderBottomColor: colors.textSecondary
  },
  tabLabelRow: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  tabText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: 13
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  newTerminalButton: {
    width: 40,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  newTerminalButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  newTerminalButtonDisabled: {
    opacity: 0.45
  },
  // Divider between the + new-terminal button and the Quick Commands launcher,
  // matching the tab strip's borderSubtle separators.
  tabActionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: colors.borderSubtle
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden'
  },
  terminalPane: {
    ...StyleSheet.absoluteFillObject
  },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  },
  markdownFrame: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  browserFrame: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  markdownEditor: {
    flex: 1,
    position: 'relative'
  },
  markdownState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md
  },
  markdownError: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  }
})
