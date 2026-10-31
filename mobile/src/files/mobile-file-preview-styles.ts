import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
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
    backgroundColor: colors.bgBase
  },
  textContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xl
  },
  textPreview: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  },
  markdownContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xl
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
    padding: spacing.lg
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
