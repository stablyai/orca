import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const TEXT_SIZE = 17
/** Chat prose reads larger than the Markdown renderer's compact base. */
export const CHAT_PROSE_SCALE = 1.25

/** Pinch-zoomed type keeps its leading, so zoomed lines never overlap. */
export function scaledType(size: number, fontScale: number, leading = 6) {
  return { fontSize: size * fontScale, lineHeight: (size + leading) * fontScale }
}
export const MONO_SIZE = 12

export const styles = StyleSheet.create({
  imageGallery: {
    width: '88%',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginBottom: spacing.sm
  },
  imageGalleryTile: {
    width: 88,
    flexShrink: 1,
    aspectRatio: 1,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  imageGalleryFill: { width: '100%', height: '100%' },
  fileGallery: { flexWrap: 'wrap' },
  fileTile: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    backgroundColor: colors.bgRaised
  },
  fileName: { color: colors.textPrimary, fontSize: typography.metaSize, textAlign: 'center' },
  imageGalleryMore: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  imageGalleryCount: { color: colors.textPrimary, fontSize: typography.titleSize },
  imageGalleryScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  imageGalleryOverflowCount: {
    color: colors.onAccent,
    fontSize: 24,
    fontWeight: '600'
  },
  imageViewer: { flex: 1, backgroundColor: colors.bgBase },
  imageViewerHeader: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  imageViewerTitle: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize },
  imageViewerClose: { padding: spacing.sm },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  rowUser: {
    alignItems: 'flex-end'
  },
  content: {
    maxWidth: '100%',
    gap: spacing.sm
  },
  userBubble: {
    maxWidth: '88%',
    backgroundColor: colors.textPrimary,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  hostNotice: {
    color: colors.textMuted
  },
  reasoning: {
    opacity: 0.7,
    // Starts under the headline, past the 15 pt brain and its gap.
    paddingLeft: 15 + spacing.sm
  },
  reasoningToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // With the toggle's 6 pt hitSlop above and below, a 44 pt touch target.
    minHeight: 32
  },
  reasoningPressed: {
    opacity: 0.6
  },
  reasoningHeadline: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  reasoningCaretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  reasoningBody: {
    // The common cap for an open reasoning block (about ten lines).
    maxHeight: 240
  },
  agentMessage: {
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle
  },
  agentAttribution: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  unsentNotice: {
    maxWidth: '88%',
    marginTop: spacing.xs,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  toolRun: {
    marginTop: spacing.xs
  },
  toolRunHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  toolRunToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3
  },
  toolRunCount: {
    color: colors.statusGreen,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    fontWeight: '700'
  },
  toolRunLabel: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE
  },
  toolRunActive: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3
  },
  toolRunActiveLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  toolRunBody: {
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    marginTop: spacing.xs
  },
  toolLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3
  },
  toolName: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE + 1,
    fontWeight: '600'
  },
  toolPreview: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE
  },
  toolPreviewLink: {
    color: colors.accentBlue,
    textDecorationLine: 'underline'
  },
  toolDetail: {
    paddingLeft: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.xs
  },
  mono: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    lineHeight: MONO_SIZE + 5
  },
  toolResult: {
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    padding: spacing.md
  },
  toolResultError: {
    backgroundColor: colors.diffDeletedBg
  },
  imageRef: {
    color: colors.textSecondary,
    fontSize: TEXT_SIZE
  },
  imageThumb: {
    width: 200,
    height: 150,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  diff: {
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.xs,
    overflow: 'hidden'
  },
  diffLine: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: MONO_SIZE,
    lineHeight: MONO_SIZE + 5,
    paddingHorizontal: spacing.sm
  },
  diffAdd: {
    color: colors.gitDecorationAdded,
    backgroundColor: colors.diffAddedBg
  },
  diffDel: {
    color: colors.gitDecorationDeleted,
    backgroundColor: colors.diffDeletedBg
  },
  diffMeta: {
    color: colors.textMuted
  }
})
