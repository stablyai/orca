import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

export const filePreviewStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  scroll: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  textContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl + spacing.lg
  },
  textPreview: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    // Jump-to-line scrolls by this height (mobile-file-preview-line-column.ts).
    lineHeight: 19
  },
  markdownContent: {
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl + spacing.lg
  },
  modeContainer: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  truncatedNote: {
    ...textStyles.footnote,
    alignSelf: 'flex-start',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    overflow: 'hidden',
    backgroundColor: colors.fill,
    color: colors.textSecondary
  },
  imageContainer: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  imageScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md
  },
  image: {
    backgroundColor: colors.bgBase
  },
  editContainer: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingTop: spacing.sm
  },
  saveError: {
    marginBottom: spacing.sm
  },
  editInput: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: 24
  }
})
