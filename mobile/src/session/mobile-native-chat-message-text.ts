import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { isTextBlock } from './mobile-native-chat-blocks'

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
