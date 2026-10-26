import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'

export const mobileSessionFrameStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  kavInner: {
    flex: 1
  },
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
  // Each 36pt visual reserves 4pt per side for its 44pt touch area.
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: spacing.xs
  },
  headerButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  headerButtonActive: {
    backgroundColor: colors.bgRaised
  },
  headerButtonDisabled: {
    opacity: 0.45
  },
  sessionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  // Landscape phone: the tab strip takes the row's spare width instead of the title.
  sessionTitleBlockBesideTabs: {
    // Use natural-width flex -1: web’s zero basis for flex 0 collapses the title.
    flex: -1,
    maxWidth: 160
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600'
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
  // Cancels the top bar's vertical padding so tab borders run the bar's full height.
  tabBarInTopBar: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginVertical: -spacing.xs,
    marginLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  tabScrollFrame: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch'
  },
  tabEdgeHint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.bgPanel
  },
  tabEdgeHintLeft: {
    left: 0,
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  tabEdgeHintRight: {
    right: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  tabScroll: {
    flex: 1,
    maxHeight: 44
  },
  tabScrollInTopBar: {
    alignSelf: 'stretch',
    maxHeight: 44
  },
  tabContent: {
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm
  },
  tabContentInTopBar: {
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
  tabLabelRow: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  // Prevent web SVG shrink before the title ellipsizes.
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
  newTerminalButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  tabActionDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: colors.borderSubtle
  },
  contentFrame: {
    flex: 1,
    minHeight: 0
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
