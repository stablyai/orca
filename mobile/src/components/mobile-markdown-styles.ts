import { StyleSheet, type TextStyle } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, themedStyles } from '../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
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
    paddingLeft: spacing.sm,
    gap: spacing.xs
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
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  codeBody: { flex: 1 },
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
  list: {
    gap: spacing.xs
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  listMarker: {
    // A floor, not a width: "10." would wrap inside a fixed 22.
    minWidth: 22,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily
  },
  listItemBody: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs
  },
  listText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  footnoteReference: {
    color: colors.textSecondary
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  }
}))

/** A style's size and line height under the reader's zoom; null at 1x, where the sheet holds. */
export function scaledMarkdownText(
  style: { fontSize: number; lineHeight: number },
  textScale: number
): { fontSize: number; lineHeight: number } | null {
  return textScale !== 1
    ? { fontSize: style.fontSize * textScale, lineHeight: style.lineHeight * textScale }
    : null
}

export type MarkdownTone = {
  text: TextStyle | null
  secondary: TextStyle | null
  link: TextStyle | null
  inlineCode: TextStyle | null
}

/** Colours over the styles above, for one surface. The default tone overrides nothing. */
export const MARKDOWN_TONES: Record<'default' | 'userMessage', MarkdownTone> = {
  default: { text: null, secondary: null, link: null, inlineCode: null },
  // Desktop's user bubble only strengthens the text; links and code keep their chat colors.
  userMessage: themedStyles(() => ({
    text: { color: colors.chatForegroundStrong },
    secondary: null,
    link: null,
    inlineCode: null
  }))
}
