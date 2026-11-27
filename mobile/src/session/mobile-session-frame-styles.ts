import { StyleSheet } from 'react-native'

import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileSessionFrameStyles = themedStyleSheet(() => ({
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
    ...StyleSheet.absoluteFill
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
  }
}))
