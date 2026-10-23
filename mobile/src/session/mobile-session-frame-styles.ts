import { StyleSheet } from 'react-native'

import { colors, spacing, typography } from '../theme/mobile-theme'

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
  // The content slot every branch renders in, measured as the terminal's frame; clips nothing.
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
