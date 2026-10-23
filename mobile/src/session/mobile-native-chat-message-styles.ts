import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'

/** Pinch-zoomed type keeps its leading, so zoomed lines never overlap. */
export function scaledType(size: number, fontScale: number, leading = 6) {
  return { fontSize: size * fontScale, lineHeight: (size + leading) * fontScale }
}

/** A ramp step under the reader's pinch zoom. */
export function scaledText(
  step: { fontSize: number; lineHeight: number },
  fontScale: number
): { fontSize: number; lineHeight: number } {
  return { fontSize: step.fontSize * fontScale, lineHeight: step.lineHeight * fontScale }
}

/** Code and tool output: the footnote size, the floor for mono content. */
export const MONO_SIZE = 13
/** Your message: a faint raised tint like desktop's, so Send stays the one bright object. */
const BUBBLE_RADIUS = 20

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
    maxWidth: '86%',
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fieldBorder,
    borderRadius: BUBBLE_RADIUS,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  hostNotice: {
    ...textStyles.body,
    color: colors.textMuted
  },
  reasoning: {
    opacity: 0.75,
    // Starts under the headline, past the 16 pt brain and its gap.
    paddingLeft: 16 + spacing.sm
  },
  reasoningBody: {
    // The common cap for an open reasoning block (about ten lines).
    maxHeight: 240
  },
  agentMessage: {
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.fieldBorder
  },
  agentAttribution: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  // The copy button's 44 pt touch box overhangs its 32 pt circle; the row pulls it back in.
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginVertical: -spacing.xs
  },
  unsentNotice: {
    ...textStyles.footnote,
    maxWidth: '86%',
    marginTop: spacing.xs,
    color: colors.danger
  },
  showFullText: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  imageRef: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  imageRefText: {
    ...textStyles.callout,
    flexShrink: 1,
    color: colors.textSecondary
  },
  imageThumb: {
    width: 200,
    height: 150,
    borderRadius: radii.card,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator
  }
})
