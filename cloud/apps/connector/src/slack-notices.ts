import type { Notice, NoticeTarget } from './connector-adapter.js'
import { noticeText } from './connector-copy.js'
import type { PostBody } from './connector-posts.js'
import { slackText } from './slack-text.js'

// Meant only for the person who wrote: ephemeral in a channel; in a DM it is theirs anyway. Slack
// shows a threaded ephemeral only in a thread that already exists, so a top-level mention's goes to
// the channel.
export function slackNotice(
  target: NoticeTarget,
  notice: Notice
): { kind: 'message' | 'ephemeral'; body: PostBody } {
  const text = noticeText(slackText, notice)
  return target.direct
    ? { kind: 'message', body: { text } }
    : {
        kind: 'ephemeral',
        body: {
          text,
          user: target.userId,
          ...(target.messageId === target.place.threadId ? {} : { threadTs: target.place.threadId })
        }
      }
}
