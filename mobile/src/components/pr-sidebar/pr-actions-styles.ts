import { StyleSheet } from 'react-native'
import { spacing } from '../../theme/mobile-theme'
import { PR_PAGE_INSET } from './mobile-pr-sidebar-styles'

export const prActionsStyles = StyleSheet.create({
  actionsBlock: {
    paddingTop: spacing.lg,
    gap: spacing.md
  },
  actionsInset: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md
  },
  autoMergeGroup: {
    marginHorizontal: 0
  },
  // Equal halves under the full-width Merge, so the actions line up as one block.
  secondaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: PR_PAGE_INSET - spacing.lg
  },
  secondaryButton: { flex: 1 }
})
