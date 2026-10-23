import { StyleSheet } from 'react-native'
import { spacing } from '../../theme/mobile-theme'

export const prCommentComposerStyles = StyleSheet.create({
  container: {
    gap: spacing.xs
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end'
  }
})
