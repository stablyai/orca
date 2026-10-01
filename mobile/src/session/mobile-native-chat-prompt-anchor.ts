import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Resolve the newest loaded prompt in the actual list order, excluding pending echoes. */
export function mobileNativeChatLatestPromptIndex(
  messages: readonly NativeChatMessage[],
  listMessages: readonly NativeChatMessage[] = messages
): number | null {
  const prompt = messages.findLast((message) => message.role === 'user')
  const index = prompt ? listMessages.findIndex((message) => message.id === prompt.id) : -1
  return index === -1 ? null : index
}
