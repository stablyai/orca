import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'

// Why one constant for the whole strip: the terminal frame is whatever the tab bar leaves behind,
// and the engine pre-warm has to reserve exactly that much before the bar exists. Every row child
// is pinned to this height so nothing can grow the bar without moving the reservation with it.
//
// The row deliberately has NO explicit height. React Native lays out border-box, so `height: 36`
// with a 1 px top border would render a 36 px row over a 35 px content area and squeeze children
// that are themselves 36 -- and it would leave this constant one pixel long, which is a whole row
// of drift once a frame sits near a row boundary. Left to size itself the row takes its tallest
// child and adds the border outside it, which is exactly the sum below.
export const MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT = 36
export const MOBILE_SESSION_TAB_BAR_BORDER_WIDTH = 1
export const MOBILE_SESSION_TAB_BAR_HEIGHT =
  MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT + MOBILE_SESSION_TAB_BAR_BORDER_WIDTH

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
    borderTopWidth: MOBILE_SESSION_TAB_BAR_BORDER_WIDTH,
    borderTopColor: colors.borderSubtle
  },
  tabScroll: {
    flex: 1,
    maxHeight: MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT
  },
  tabContent: {
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm
  },
  tab: {
    width: 128,
    maxWidth: 128,
    minHeight: MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  // Why: a cached row is inert until the reconnect lands, so it carries the same de-emphasis as
  // the disabled tab-bar buttons beside it rather than passing for a live tab.
  tabPreview: {
    opacity: 0.45
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
    height: MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT,
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
