import { Platform, StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileSessionReaderStyles = themedStyleSheet(() => ({
  markdownTextInput: {
    flex: 1,
    minHeight: 0,
    color: colors.textPrimary,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl * 3,
    fontSize: typography.bodySize,
    lineHeight: 22,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  filePreviewScroll: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.editorSurface
  },
  filePreviewContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl
  },
  filePreviewText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: 22,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  imagePreviewContainer: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.editorSurface
  },
  imagePreviewScroll: {
    flex: 1
  },
  imagePreviewContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg
  },
  imagePreview: {
    width: '100%',
    height: '100%',
    minHeight: 200
  },
  fileReaderToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  fileReaderPath: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginHorizontal: spacing.sm
  },
  fileReaderToolbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  fileReaderToolbarButton: {
    width: 30,
    height: 30,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fileReaderToolbarButtonActive: {
    backgroundColor: colors.bgRaised,
    borderColor: colors.accentBlue
  },
  diffNotesToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  diffNotesTitleRow: {
    minWidth: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  diffNotesTitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  diffNotesActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  diffNotesActionButton: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgRaised
  },
  diffNotesActionText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  diffLineBlock: {
    marginBottom: spacing.xs
  },
  diffLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderLeftWidth: 2,
    borderLeftColor: colors.editorSurface,
    paddingRight: spacing.sm
  },
  diffLineAdded: {
    backgroundColor: colors.diffAddedBg,
    borderLeftColor: colors.gitDecorationAdded
  },
  diffLineDeleted: {
    backgroundColor: colors.diffDeletedBg,
    borderLeftColor: colors.gitDecorationDeleted
  },
  diffGutter: {
    width: 42,
    paddingRight: spacing.sm,
    textAlign: 'right',
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 22,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  diffText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: 22,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  diffPrefix: {
    color: colors.textMuted
  },
  diffPrefixAdded: {
    color: colors.gitDecorationAdded
  },
  diffPrefixDeleted: {
    color: colors.gitDecorationDeleted
  }
}))
