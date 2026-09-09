import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Index of the prompt an agent message is answering: the nearest `user`
 *  message above `index` in the rendered list, or `null` when there is none.
 *
 *  Why nearest-above rather than "the last prompt in the session": the control
 *  is rendered per message, so pressing it on an older answer has to land on
 *  the prompt that produced *that* answer. On the newest answer the two
 *  coincide, which is the case this exists for — reading a long reply from the
 *  question that started it.
 *
 *  Returns `null` for a transcript that was paged in mid-session, or a scraped
 *  one with no user turns, so the caller can fall back rather than scrolling
 *  somewhere arbitrary. */
export function mobileNativeChatPromptAnchorIndex(
  messages: readonly NativeChatMessage[],
  index: number
): number | null {
  // Clamp rather than trust the caller: `index` comes from the list and can
  // outrun `messages` for a frame while a transient bubble is retired.
  const start = Math.min(index, messages.length)
  for (let i = start - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return i
    }
  }
  return null
}
