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
import { refreshSlackStatus, statusPostId } from './slack-thread-posts.js'

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

// A press of a button on a prompt card (answer) or on the status message (stop). What it acts on is
// found from the message it is on; the button only says which option or turn.
export type SlackClick = {
  teamId: string
  channelId: string
  userId: string
  messageTs: string
  button: { kind: 'answer'; optionId: string } | { kind: 'stop'; turnId: number }
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
  const value = action?.value
  const button =
    value === undefined
      ? undefined
      : action?.action_id.startsWith('answer:')
        ? { kind: 'answer' as const, optionId: value }
        : action?.action_id === 'stop' && Number.isSafeInteger(Number(value))
          ? { kind: 'stop' as const, turnId: Number(value) }
          : undefined
  if (!button) {
    return 'ignored'
  }
  return {
    teamId: parsed.data.team.id,
    channelId: parsed.data.channel.id,
    userId: parsed.data.user.id,
    messageTs: parsed.data.container.message_ts,
    button
  }
}

// Decisions §1: only the conversation's owner answers or stops; anyone else is told so privately.
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
    // The button must sit on the message that offers it: a stop on a status, an answer on a card.
    const thread = threads.find((row) =>
      click.button.kind === 'stop'
        ? postId === statusPostId(String(row.external_id))
        : postId.startsWith(promptCardId(String(row.external_id), ''))
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
    const action: OwnerAction =
      click.button.kind === 'stop'
        ? click.button
        : {
            kind: 'answer',
            promptId: postId.slice(promptCardId(externalId, '').length),
            optionId: click.button.optionId
          }
    if (action.kind === 'answer') {
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
    }
    const outcome = await applyOwnerAction(transaction, queue, externalId, click.userId, action)
    switch (outcome?.kind) {
      case 'not_owner':
        await tell(`only-owner:${postId}:${click.userId}`, slackText.onlyOwner(outcome.ownerUserId))
        return
      case 'moved_on':
        // A repeated Stop needs no reply: the status already says it is stopping or done.
        if (action.kind === 'answer') {
          await tell(`moved-on:${postId}:${click.userId}`, slackText.alreadyAnswered)
        }
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
        return
      case 'stopping':
        await refreshSlackStatus(transaction, posts, String(thread.host_id), externalId)
    }
  })
}
