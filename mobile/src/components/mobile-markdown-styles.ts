import { Platform, StyleSheet, type TextStyle } from 'react-native'
import { colors, onBrightColors, radii, spacing, textStyles } from '../theme/mobile-theme'

/** Desktop's `--font-mono` stack on the page; iOS has no font named `monospace`, so it names Menlo. */
export const CODE_FONT_FAMILY =
  Platform.OS === 'web'
    ? "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    : Platform.OS === 'ios'
      ? 'Menlo'
      : 'monospace'

// Reading prose: the body step with a little more leading, as long replies need.
const PROSE = { ...textStyles.body, lineHeight: 24 }

export const styles = StyleSheet.create({
  root: {
    gap: spacing.md
  },
  paragraph: {
    ...PROSE,
    color: colors.textPrimary
  },
  /** h3 and below: body size, set apart by weight alone. */
  heading: {
    ...textStyles.body,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.textPrimary
  },
  headingMedium: {
    ...textStyles.headline,
    lineHeight: 24
  },
  headingLarge: {
    ...textStyles.title
  },
  bold: {
    fontWeight: '600',
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
    fontFamily: CODE_FONT_FAMILY,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.fill,
    borderRadius: radii.row,
    paddingHorizontal: 4
  },
  inlineCodeLink: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.fieldBorder,
    paddingLeft: spacing.md,
    gap: spacing.sm
  },
  quoteText: {
    ...PROSE,
    color: colors.textSecondary
  },
  codeBlock: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radii.field,
    paddingHorizontal: spacing.md,
    paddingVertical: 10
  },
  codeLanguage: {
    ...textStyles.footnote,
    color: colors.textMuted,
    marginBottom: spacing.xs
  },
  codeText: {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  imageFrame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radii.field,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden',
    padding: spacing.md,
    gap: 2
  },
  imageCaption: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  table: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder,
    borderRadius: radii.field - 4,
    overflow: 'hidden',
    backgroundColor: colors.bgPanel
  },
  tableRow: {
    flexDirection: 'row'
  },
  tableCell: {
    ...textStyles.footnote,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.textPrimary
  },
  tableHeader: {
    fontWeight: '600',
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
  /** The list's own size and leading, so a marker sits on its item's first line. */
  listMarker: {
    ...PROSE,
    // A floor, not a width: "10." would wrap inside a fixed one.
    minWidth: 18,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  listItemBody: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs
  },
  /** Lists read at the paragraph's size. */
  listText: {
    ...PROSE,
    color: colors.textPrimary
  },
  footnoteReference: {
    color: colors.textSecondary
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator
  }
})

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
export const MARKDOWN_TONES: Record<'default' | 'onBright', MarkdownTone> = {
  default: { text: null, secondary: null, link: null, inlineCode: null },
  onBright: StyleSheet.create({
    text: { color: colors.bgBase },
    secondary: { color: onBrightColors.secondary },
    link: { color: onBrightColors.link },
    inlineCode: { color: colors.bgBase, backgroundColor: onBrightColors.codeBackground }
  })
}
