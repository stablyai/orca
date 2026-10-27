import type { Notice, NoticeTarget, ThreadPlace } from './connector-adapter.js'
import { noticeText } from './connector-copy.js'
import type { PostBody } from './connector-posts.js'
import { discordText } from './discord-text.js'

// The channel a message sits in: a top-level mention's thread doesn't exist until Orca first posts.
export const messageChannel = (place: ThreadPlace, messageId: string) =>
  messageId === place.threadId ? place.containerId : place.threadId

// Ordinary Discord messages can't be private, so a notice is a public reply to the message it
// answers, beside it.
export function discordNotice(
  target: NoticeTarget,
  notice: Notice
): { kind: 'message' | 'ephemeral'; body: PostBody } {
  const { place, messageId } = target
  return {
    kind: 'message',
    body: {
      content: noticeText(discordText, notice),
      ...(messageId === undefined
        ? {}
        : { replyTo: messageId, channelId: messageChannel(place, messageId) })
    }
  }
}
