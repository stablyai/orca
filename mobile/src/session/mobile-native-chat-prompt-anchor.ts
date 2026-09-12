import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Index of the newest `user` message in the rendered list, or `null` when the
 *  loaded transcript has none (paged in mid-session, or a scrape with no prompts). */
export function mobileNativeChatLatestPromptIndex(
  messages: readonly NativeChatMessage[]
): number | null {
  const index = messages.findLastIndex((message) => message.role === 'user')
  return index === -1 ? null : index
}
