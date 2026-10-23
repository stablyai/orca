import { StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'

// The "Fix checks with AI" / "Resolve conflicts with AI" affordances and their launch notices.
export const prAiTriageStyles = StyleSheet.create({
  triageArea: {
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  triageError: {
    ...textStyles.subhead,
    color: colors.danger
  }
})
