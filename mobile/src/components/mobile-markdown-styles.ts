import { StyleSheet, type TextStyle } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, themedStyles } from '../theme/themed-styles'

/** Lifts the 13pt base to 14pt body text for documents (file preview, PR bodies); headings scale with it. */
export const MOBILE_MARKDOWN_DOCUMENT_SCALE = 14 / 13

export const styles = themedStyleSheet(() => ({
  root: {
    gap: spacing.md
  },
  paragraph: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.textPrimary
  },
  heading: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
    color: colors.textPrimary
  },
  headingLarge: {
    fontSize: 16,
    lineHeight: 23
  },
  headingTitle: {
    fontSize: 18,
    lineHeight: 25
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.mark,
    paddingHorizontal: 4
  },
  // GitHub's inline tags: raised and lowered small text, a key cap, an insertion.
  sup: { fontSize: 10, position: 'relative', top: -5 },
  sub: { fontSize: 10, position: 'relative', top: 3 },
  kbd: { borderWidth: 1, borderColor: colors.borderSubtle },
  ins: { textDecorationLine: 'underline' },
  inlineCodeLink: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  callout: {
    borderLeftWidth: 2,
    borderTopRightRadius: radii.surface,
    borderBottomRightRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm
  },
  calloutTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  calloutTitleText: { fontSize: 13, fontWeight: '600' },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    borderTopRightRadius: radii.surface,
    borderBottomRightRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm
  },
  quoteText: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.textSecondary
  },
  codeBlock: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 32,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  codeLanguage: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    textTransform: 'uppercase'
  },
  codeBody: {
    flexDirection: 'row',
    paddingVertical: spacing.sm
  },
  codeLineNumbers: {
    paddingHorizontal: spacing.sm,
    color: colors.textMuted,
    textAlign: 'right'
  },
  codeLines: {
    paddingRight: spacing.md
  },
  codeLinesWrapped: {
    flex: 1,
    paddingLeft: spacing.md
  },
  codeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  codeWrapButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  codeWrapButtonOn: {
    backgroundColor: colors.translucentFill
  },

  codeText: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  imageParagraph: {
    gap: spacing.sm
  },
  details: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  detailsSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgRaised
  },
  detailsSummaryText: { fontWeight: '600', flexShrink: 1 },
  detailsBody: { padding: spacing.sm, gap: spacing.md },
  imageFrame: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
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
  tableScroll: {
    minWidth: '100%'
  },
  table: {
    flexGrow: 1,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
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
    color: colors.textPrimary,
    // Every row grows its cells from the same widths, so a short table fills the message aligned.
    flexGrow: 1,
    flexShrink: 0
  },
  tableHeader: {
    fontWeight: '700',
    backgroundColor: colors.bgRaised
  },
  list: {
    gap: spacing.sm
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
    lineHeight: 21,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily
  },
  listItemBody: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs
  },
  taskMarker: { minWidth: 22, justifyContent: 'center' },
  listText: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.textPrimary
  },
  footnoteReference: {
    color: colors.accentBlue
  },
  rule: {
    marginVertical: spacing.xs,
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

/** Colours and weight over the styles above, for one surface. The default tone overrides nothing. */
export const MARKDOWN_TONES: Record<
  'default' | 'userMessage' | 'strong' | 'medium' | 'muted',
  MarkdownTone
> = {
  default: { text: null, secondary: null, link: null, inlineCode: null },
  // A card's title: the question an agent asks.
  strong: { text: { fontWeight: '600' }, secondary: null, link: null, inlineCode: null },
  // The answer card's question: body size, lighter than its options' bold labels.
  medium: { text: { fontWeight: '500' }, secondary: null, link: null, inlineCode: null },
  // Settled text beside a receipt's muted answer.
  muted: themedStyles(() => ({
    text: { color: colors.textMuted },
    secondary: null,
    link: null,
    inlineCode: null
  })),
  // Desktop's user bubble only strengthens the text; links and code keep their chat colors.
  userMessage: themedStyles(() => ({
    text: { color: colors.chatForegroundStrong },
    secondary: null,
    link: null,
    inlineCode: null
  }))
}
