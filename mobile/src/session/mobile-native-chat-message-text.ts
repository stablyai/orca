import { isTextBlock, type NativeChatBlock } from '../../../src/shared/native-chat-types'

/** Concatenate a message's text blocks into a single copyable string. Tool
 *  calls/results and image refs are skipped — Copy is for the agent's prose. */
export function nativeChatMessageText(blocks: readonly NativeChatBlock[]): string {
  return blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

/** Pinch-to-zoom font bounds. Default 1 means no visible change until pinched. */
export const FONT_SCALE_MIN = 0.8
export const FONT_SCALE_MAX = 1.8

/** Clamp a proposed font scale into the supported range. */
export function clampFontScale(scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
}

/** Granularity a pinch is allowed to commit at. */
export const FONT_SCALE_STEP = 0.05

/** Snap a proposed font scale to the nearest committed step.
 *
 *  Why quantize: the chat's `renderItem` closes over `fontScale`, so every
 *  distinct value re-renders and re-measures every message in the list. A raw
 *  pinch proposes a new scale on each gesture frame, so a single zoom drives
 *  hundreds of whole-list re-measures — and because the pinch is composed
 *  `Simultaneous` with the list's own scroll, an incidental second finger during
 *  a scroll starts that storm at scales indistinguishable from 1. Those
 *  re-measures run while rows are mounting and unmounting, which is when a
 *  recycled iOS paragraph view can repaint with the previous row's content
 *  frame and silently drop the tail of a long message. Snapping to steps keeps a
 *  full-range pinch to at most 20 commits and makes a near-neutral pinch commit
 *  nothing at all. */
export function quantizeFontScale(scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }
  const stepped = Math.round(clampFontScale(scale) / FONT_SCALE_STEP) * FONT_SCALE_STEP
  // Re-clamp: rounding can push the outermost step past the bound.
  return clampFontScale(Number(stepped.toFixed(2)))
}
