import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/** Base of the inline image thumbnail, kept beside the sheet so the pinch scale never drifts from it. */
export const MARKDOWN_INLINE_IMAGE_WIDTH = 100
export const MARKDOWN_INLINE_IMAGE_HEIGHT = 130

export const styles = StyleSheet.create({
  root: {
    gap: spacing.sm
  },
  paragraph: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  heading: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  headingLarge: {
    fontSize: 15,
    lineHeight: 21
  },
  bold: {
    fontWeight: '700',
    color: colors.textPrimary
  },
  italic: {
    fontStyle: 'italic'
  },
  strike: {
    textDecorationLine: 'line-through'
  },
  link: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  inlineCode: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.row,
    paddingHorizontal: 4
  },
  inlineCodeLink: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingLeft: spacing.sm
  },
  quoteText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary
  },
  codeBlock: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    padding: spacing.sm
  },
  codeLanguage: {
    fontSize: 10,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    textTransform: 'uppercase'
  },
  codeText: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  imageFrame: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden',
    padding: spacing.sm
  },
  imageCaption: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: 11,
    color: colors.textSecondary
  },
  markdownImageFrame: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    overflow: 'hidden'
  },
  markdownImageSizing: {
    width: '100%',
    height: 180
  },
  markdownInlineImage: {
    width: MARKDOWN_INLINE_IMAGE_WIDTH,
    height: MARKDOWN_INLINE_IMAGE_HEIGHT,
    marginVertical: 2
  },
  table: {
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    overflow: 'hidden',
    backgroundColor: colors.bgPanel
  },
  tableRow: {
    flexDirection: 'row'
  },
  tableCell: {
    minWidth: 112,
    maxWidth: 220,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  tableHeader: {
    fontWeight: '700',
    backgroundColor: colors.bgRaised
  },
  tableTruncated: {
    padding: spacing.sm,
    fontSize: 12,
    color: colors.textMuted
  },
  list: {
    gap: spacing.xs
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  listMarker: {
    width: 22,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily
  },
  listText: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  }
})
