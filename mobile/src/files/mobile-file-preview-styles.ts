import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  toolbarButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: 'transparent'
  },
  toolbarButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  toolbarButtonActive: {
    backgroundColor: colors.bgRaised
  },
  saveButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  saveButtonDisabled: {
    opacity: 0.42
  },
  scroll: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  textContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xl
  },
  textContentWithLines: {
    paddingLeft: 2,
    paddingRight: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl
  },
  textPreview: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  },
  sourceLinesContainer: {
    width: '100%'
  },
  sourceLineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 19
  },
  sourceLineRowTarget: {
    backgroundColor: colors.skillTokenSurface,
    borderRadius: radii.control
  },
  sourceLineNumber: {
    flexShrink: 0,
    paddingRight: 6,
    textAlign: 'right',
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 19
  },
  sourceLineNumberTarget: {
    color: colors.accentBlue,
    fontWeight: '700'
  },
  sourceLineText: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  },
  markdownContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xl
  },
  modeContainer: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  codeContainer: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  modeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs
  },
  modeSwitch: {
    backgroundColor: colors.bgPanel
  },
  truncatedNote: {
    marginBottom: spacing.md,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  imageContainer: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  editContainer: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  saveErrorText: {
    marginBottom: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  previewSaveErrorText: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  editInput: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    // iOS zooms the page when a field under 16px takes focus; a literal, not the seam, avoids an extra shared chunk.
    fontSize: 16,
    lineHeight: 22,
    padding: 0
  }
}))

export const chatAttachmentPreviewStyles = themedStyleSheet(() => ({
  ...filePreviewStyles,
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderCurve: 'circular'
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  },
  meta: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  saveButtonDisabled: {
    opacity: 0.42
  },
  scroll: {
    flex: 1,
    backgroundColor: colors.editorSurface
  },
  textContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl
  }
}))
