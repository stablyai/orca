import { StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'
import { PR_PAGE_INSET } from './mobile-pr-sidebar-styles'

// The no-PR state: the StateView layout, with room for a progress line and a commit failure.
export const prCreateEmptyStateStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing.xl + 16
  },
  body: {
    alignSelf: 'center',
    maxWidth: 320,
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.xl
  },
  title: {
    ...textStyles.title,
    fontSize: 20,
    lineHeight: 25,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 6
  },
  message: {
    ...textStyles.callout,
    color: colors.textSecondary,
    textAlign: 'center'
  },
  actions: {
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  notice: {
    paddingTop: spacing.lg
  },
  failure: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },
  composerArea: {
    paddingHorizontal: PR_PAGE_INSET,
    paddingTop: spacing.lg
  }
})
