import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import { lockConnectorHost } from './connector-hosts.js'
import { applyOwnerAction, type OwnerAction } from './owner-controls.js'
import type { SlackConfig } from './slack-config.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackPosts } from './slack-posts.js'
import { isOpenCard, promptCardId, settledCard } from './slack-prompt-cards.js'
import type { QueueInTransaction } from './queue-delivery.js'
import { slackText } from './slack-text.js'
import { refreshSlackStatus } from './slack-thread-posts.js'

const BlockActionsSchema = z.looseObject({
  type: z.literal('block_actions'),
  team: z.looseObject({ id: z.string().min(1) }),
  user: z.looseObject({ id: z.string().min(1) }),
  channel: z.looseObject({ id: z.string().min(1) }),
  container: z.looseObject({ message_ts: z.string().min(1) }),
  actions: z
    .array(z.looseObject({ action_id: z.string(), value: z.string().min(1).optional() }))
    .min(1)
})

// A press of an answer button on a prompt card. What it answers is found from the message it is
// on; the button only says which option.
export type SlackClick = {
  teamId: string
  channelId: string
  userId: string
  messageTs: string
  optionId: string
}

// Slack sends interactions form-encoded, the JSON in `payload`. Other interactions are ignored.
export function readSlackClick(rawBody: string): SlackClick | 'ignored' | 'invalid' {
  let payload: unknown
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '')
  } catch {
    return 'invalid'
  }
  const parsed = BlockActionsSchema.safeParse(payload)
  if (!parsed.success) {
    return typeof payload === 'object' && payload !== null ? 'ignored' : 'invalid'
  }
  const [action] = parsed.data.actions
  if (!action?.action_id.startsWith('answer:') || action.value === undefined) {
    return 'ignored'
  }
  return {
    teamId: parsed.data.team.id,
    channelId: parsed.data.channel.id,
    userId: parsed.data.user.id,
    messageTs: parsed.data.container.message_ts,
    optionId: action.value
  }
}

// Decisions §1: only the conversation's owner answers; anyone else is told so privately.
export async function handleSlackClick(
  deps: {
    config: SlackConfig
    database: CloudDatabase
    installs: SlackInstalls
    posts: SlackPosts
    queue: QueueInTransaction
  },
  click: SlackClick
): Promise<void> {
  const { config, installs, posts, queue } = deps
  await deps.database.transaction(async (transaction) => {
    const install = await installs.find(transaction, click.teamId)
    const [message] = await transaction.query(
      `SELECT post_id, thread_ts, body FROM connector_slack_posts
       WHERE team_id = ? AND channel_id = ? AND slack_ts = ? AND kind = 'status'`,
      [click.teamId, click.channelId, click.messageTs]
    )
    if (!install || !message) {
      return
    }
    const postId = String(message.post_id)
    const place = {
      teamId: click.teamId,
      channelId: click.channelId,
      threadTs: String(message.thread_ts)
    }
    const threads = await transaction.query(
      `SELECT external_id, host_id FROM connector_threads
       WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
      [place.teamId, place.channelId, place.threadTs]
    )
    const thread = threads.find((row) =>
      postId.startsWith(promptCardId(String(row.external_id), ''))
    )
    if (!thread) {
      return
    }
    const externalId = String(thread.external_id)
    const tell = (id: string, text: string) =>
      posts.queue(transaction, {
        ...place,
        postId: id,
        kind: 'ephemeral',
        body: { text, user: click.userId, threadTs: place.threadTs }
      })
    if (config.paused || install.paused) {
      await tell(
        `paused:${place.teamId}:${place.channelId}:${place.threadTs}:${click.userId}`,
        slackText.paused
      )
      return
    }
    // Cards close only under the host lock (events, clicks), so this read holds until commit.
    await lockConnectorHost(transaction, String(thread.host_id))
    const [card] = await transaction.query(
      'SELECT body FROM connector_slack_posts WHERE post_id = ?',
      [postId]
    )
    if (!isOpenCard(JSON.parse(String(card?.body ?? '{}')))) {
      await tell(`moved-on:${postId}:${click.userId}`, slackText.alreadyAnswered)
      return
    }
    const action: OwnerAction = {
      kind: 'answer',
      promptId: postId.slice(promptCardId(externalId, '').length),
      optionId: click.optionId
    }
    const outcome = await applyOwnerAction(transaction, queue, externalId, click.userId, action)
    switch (outcome?.kind) {
      case 'not_owner':
        await tell(`only-owner:${postId}:${click.userId}`, slackText.onlyOwner(outcome.ownerUserId))
        return
      case 'moved_on':
        await tell(`moved-on:${postId}:${click.userId}`, slackText.alreadyAnswered)
        return
      case 'answered':
        await transaction.lockQuotaScope(`orca-connector-slack-status:${externalId}`)
        await posts.setStatus(transaction, {
          ...place,
          postId,
          ...settledCard(
            JSON.parse(String(message.body)),
            slackText.promptAnswered(outcome.ownerUserId, outcome.label)
          )
        })
        await refreshSlackStatus(transaction, posts, String(thread.host_id), externalId)
    }
  })
}
