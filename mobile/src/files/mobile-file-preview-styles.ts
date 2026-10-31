import { StyleSheet } from 'react-native'
import { colors, concentricRadius, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const filePreviewStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  scroll: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  textContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl
  },
  textPreview: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  },
  markdownContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl
  },
  modeContainer: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  modeToolbar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    padding: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    backgroundColor: colors.bgPanel
  },
  modeToggle: {
    width: 34,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: concentricRadius(radii.control, 2),
    backgroundColor: 'transparent',
    opacity: 0.72
  },
  modeToggleActive: {
    backgroundColor: colors.bgRaised,
    opacity: 1
  },
  truncatedNote: {
    marginBottom: spacing.md,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  imageContainer: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  imageScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md
  },
  image: {
    backgroundColor: colors.editorSurface
  },
  editContainer: {
    flex: 1,
    backgroundColor: colors.editorSurface,
    padding: spacing.md
  },
  saveErrorText: {
    marginBottom: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  editInput: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    padding: 0
  }
}))
