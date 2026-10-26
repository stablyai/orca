import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const TEXT_SIZE = 17
export const CHAT_PROSE_SCALE = 1.25

/** Pinch-zoomed type keeps its leading, so zoomed lines never overlap. */
export function scaledType(size: number, fontScale: number, leading = 6) {
  return { fontSize: size * fontScale, lineHeight: (size + leading) * fontScale }
}
export const MONO_SIZE = 12

export const styles = StyleSheet.create({
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
  showFull: {
    alignSelf: 'flex-start',
    paddingTop: spacing.xs
  },
  showFullText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
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
  }
})
