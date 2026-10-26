import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { SlackMessage } from './slack-events.js'
import type { SlackPlace, SlackPosts } from './slack-posts.js'

// 👀 on a message handed toward a machine.
export async function reactSeen(
  posts: SlackPosts,
  transaction: CloudDatabase,
  place: SlackPlace,
  messageKey: string,
  ts: string
): Promise<void> {
  await posts.queue(transaction, {
    ...place,
    postId: `eyes:${messageKey}`,
    kind: 'reaction',
    body: { name: 'eyes', timestamp: ts }
  })
}

// Meant only for the person who wrote: ephemeral in a channel; in a DM it is theirs anyway. Slack
// shows a threaded ephemeral only in a thread that already exists, so a top-level mention's goes to
// the channel.
export async function replyToWriter(
  posts: SlackPosts,
  transaction: CloudDatabase,
  message: SlackMessage,
  postId: string,
  text: string
): Promise<void> {
  const place = { teamId: message.teamId, channelId: message.channelId, threadTs: message.threadTs }
  await posts.queue(
    transaction,
    message.direct
      ? { ...place, postId, kind: 'message', body: { text } }
      : {
          ...place,
          postId,
          kind: 'ephemeral',
          body: {
            text,
            user: message.userId,
            ...(message.ts === message.threadTs ? {} : { threadTs: message.threadTs })
          }
        }
  )
}
