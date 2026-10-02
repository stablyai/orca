import { StyleSheet } from 'react-native'
import { colors, spacing } from '../../theme/mobile-theme'

// Styles for the conflicts notice. Muted/monochrome to match the rest of the PR
// sidebar. Ports the LOOK of the desktop MergeConflictNotice.
export const prConflictStyles = StyleSheet.create({
  noticeTitle: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '600'
  },
  noticeBody: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: spacing.xs
  }
})
