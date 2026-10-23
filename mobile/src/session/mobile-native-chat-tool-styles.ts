import { StyleSheet } from 'react-native'
import { CODE_FONT_FAMILY } from '../components/mobile-markdown-styles'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { scaledText } from './mobile-native-chat-message-styles'

/** The chat's tool type: run sentences in the callout step, lines in subhead, code at the footnote
 *  size in mono, annotations in footnote. Pinch-zoom scales all of them. */
export function toolType(fontScale: number) {
  return {
    sentence: scaledText(textStyles.callout, fontScale),
    row: scaledText(textStyles.subhead, fontScale),
    code: scaledText({ fontSize: 13, lineHeight: 18 }, fontScale),
    meta: scaledText(textStyles.footnote, fontScale)
  }
}

/** Tool glyphs, a step under the sentence they lead. */
export const TOOL_ICON_SIZE = 16

export const toolStyles = StyleSheet.create({
  run: {
    marginTop: 2
  },
  headerSentence: {
    ...textStyles.callout,
    flexShrink: 1,
    color: colors.textSecondary
  },
  headerSentenceLive: {
    flexShrink: 0,
    maxWidth: '72%',
    color: colors.textPrimary
  },
  headerMarks: {
    flexShrink: 0
  },
  headerLatest: {
    flexShrink: 1,
    color: colors.textMuted
  },
  // Hangs from the run's glyph: its rule runs under the icon's centre.
  members: {
    marginLeft: TOOL_ICON_SIZE / 2,
    marginTop: 2,
    paddingLeft: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.fieldBorder
  },
  iconSlot: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  lineWord: {
    ...textStyles.subhead,
    flexShrink: 0,
    color: colors.textMuted
  },
  /** A row named by its tool rather than a verb keeps most of the width for that name. */
  lineName: {
    flexShrink: 0,
    maxWidth: '60%'
  },
  lineTarget: {
    ...textStyles.subhead,
    flexShrink: 1,
    color: colors.textPrimary
  },
  lineLink: {
    textDecorationLine: 'underline'
  },
  lineTrailing: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.xs
  },
  lineMeta: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  detail: {
    marginLeft: TOOL_ICON_SIZE + spacing.sm,
    paddingTop: 2,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  codeBox: {
    borderRadius: radii.field - 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: 10,
    paddingVertical: spacing.sm
  },
  /** Desktop's `max-h-64`: one long output scrolls in place instead of filling the screen. */
  codeScroll: {
    maxHeight: 256,
    flexGrow: 0
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: CODE_FONT_FAMILY
  },
  searchResults: {
    gap: spacing.xs
  },
  searchHit: {
    textDecorationLine: 'underline'
  },
  searchUrl: {
    color: colors.textMuted,
    textDecorationLine: 'none'
  },
  taskCard: {
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  taskHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  taskTitle: {
    fontWeight: '500',
    color: colors.textSecondary
  },
  taskList: {
    gap: spacing.xs,
    paddingVertical: spacing.xs
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm
  },
  taskIcon: {
    justifyContent: 'center'
  },
  taskText: {
    ...textStyles.subhead,
    flexShrink: 1,
    color: colors.textSecondary
  },
  taskActive: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  errorText: {
    color: colors.danger
  },
  // Desktop's `NativeChatDiffView`: diff text on a tinted row in the chat's own diff colours.
  diffAdd: {
    color: colors.chatDiffAdded,
    backgroundColor: colors.diffAddedBg
  },
  diffDel: {
    color: colors.chatDiffRemoved,
    backgroundColor: colors.diffDeletedBg
  },
  diffMeta: {
    color: colors.textMuted
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  cardToggle: {
    flex: 1,
    minWidth: 0,
    marginRight: 0
  },
  shrinkable: {
    flexShrink: 1
  },
  struck: {
    textDecorationLine: 'line-through'
  },
  countAdded: {
    color: colors.gitDecorationAdded
  },
  countRemoved: {
    color: colors.gitDecorationDeleted
  },
  /** Desktop's `max-h-72`: a long change scrolls in place. */
  diffBody: {
    marginLeft: TOOL_ICON_SIZE + spacing.sm,
    marginTop: 2,
    marginBottom: spacing.sm,
    maxHeight: 288,
    flexGrow: 0,
    paddingHorizontal: 0
  },
  diffRow: {
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  diffAddGround: {
    backgroundColor: colors.diffAddedBg
  },
  diffDelGround: {
    backgroundColor: colors.diffDeletedBg
  },
  diffGutter: {
    paddingRight: 6,
    textAlign: 'right',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  diffAddGutter: {
    backgroundColor: colors.diffAddedGutter
  },
  diffDelGutter: {
    backgroundColor: colors.diffDeletedGutter
  },
  diffSign: {
    width: 14,
    textAlign: 'center'
  },
  diffAddText: {
    color: colors.chatDiffAdded
  },
  diffDelText: {
    color: colors.chatDiffRemoved
  },
  diffText: {
    flex: 1,
    paddingRight: spacing.sm
  },
  diffGap: {
    textAlign: 'center',
    color: colors.textMuted,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator
  }
})
