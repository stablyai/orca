import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { CONNECTOR_AGENTS, ConnectorDeliveryResultSchema } from '@orca-cloud/connector-contract'
import type { DeliveryBody } from './connector-inbox.js'
import type { QueueInTransaction } from './queue-delivery.js'
import type { SlackConfig } from './slack-config.js'
import { mentionsBot, promptText, type SlackMessage } from './slack-events.js'
import { findSlackIdentity } from './slack-identities.js'
import type { SlackInstalls } from './slack-installs.js'
import { chooseMachine, knownHost } from './slack-machine-choice.js'
import type { SlackPlace, SlackPosts } from './slack-posts.js'
import { keepTeammateContext, withTeammateContext } from './slack-teammate-context.js'
import { slackText } from './slack-text.js'
import { reactSeen, replyToWriter } from './slack-writer-replies.js'
import { refreshSlackStatus } from './slack-thread-posts.js'

export type SlackRoutingDeps = {
  config: SlackConfig
  database: CloudDatabase
  installs: SlackInstalls
  posts: SlackPosts
  queue: QueueInTransaction
  now: () => number
}

type ThreadRow = {
  externalId: string
  ownerUserId: string
  hostId: string
  placeId: string
  paneKey: string | null
}

// Decisions §1: only a conversation's owner starts or steers it; anyone else's message in the thread
// is kept as context for the owner's next turn, and a new mention by them starts their own.
export async function routeSlackMessage(
  deps: SlackRoutingDeps,
  message: SlackMessage
): Promise<void> {
  const { teamId, channelId, threadTs, ts, userId } = message
  const messageKey = `${teamId}:${channelId}:${ts}`
  await deps.database.transaction(async (transaction) => {
    // Slack sends message and app_mention for one post, and retries both.
    const [seen] = await transaction.query(
      `INSERT INTO connector_slack_seen (message_key, seen_at) VALUES (?, ?)
       ON CONFLICT (message_key) DO NOTHING`,
      [messageKey, deps.now()]
    )
    if (Number(seen?.changes ?? 0) === 0) {
      return
    }
    const install = await deps.installs.find(transaction, teamId)
    if (!install || userId === install.botUserId) {
      return
    }
    // Serializes routing per Slack thread, so two quick messages can't both start a conversation.
    await transaction.lockQuotaScope(
      `orca-connector-slack-thread:${teamId}:${channelId}:${threadTs}`
    )
    const threads = await threadsIn(transaction, { teamId, channelId, threadTs })
    const own = threads.find((thread) => thread.ownerUserId === userId)
    const externalId = `${teamId}:${channelId}:${threadTs}:${userId}`
    const othersConversations = threads
      .filter((thread) => thread.ownerUserId !== userId)
      .map((thread) => thread.externalId)
    const addressed = own || message.direct || mentionsBot(message.text, install.botUserId)
    if (!addressed && othersConversations.length === 0) {
      return
    }
    const place = { teamId, channelId, threadTs }
    // Paused input is neither delivered nor kept for later.
    if (deps.config.paused || install.paused) {
      if (addressed) {
        await replyToWriter(
          deps.posts,
          transaction,
          message,
          `paused:${teamId}:${channelId}:${threadTs}:${userId}`,
          slackText.paused
        )
      }
      return
    }
    const text = promptText(message.text, install.botUserId)
    if (text.length === 0) {
      return
    }
    // Context for every other owner's conversation here, whatever this message does for its author.
    for (const conversation of othersConversations) {
      await keepTeammateContext(transaction, conversation, { ts, teamId, userId, text }, deps.now())
    }
    if (!addressed) {
      return
    }
    const route = { deps, transaction, message, messageKey, place, text, externalId }
    await (own ? continueConversation(route, own) : startConversation(route))
  })
}

type Route = {
  deps: SlackRoutingDeps
  transaction: CloudDatabase
  message: SlackMessage
  messageKey: string
  place: SlackPlace
  text: string
  externalId: string
}

async function startConversation(route: Route): Promise<void> {
  const { deps, transaction, message, messageKey } = route
  const identity = await findSlackIdentity(transaction, message.teamId, message.userId)
  if (!identity) {
    await replyToWriter(
      deps.posts,
      transaction,
      message,
      `unlinked:${messageKey}`,
      slackText.unlinked
    )
    return
  }
  const rows = await transaction.query(
    'SELECT host_id, host_name, hello FROM connector_hosts WHERE account_id = ? ORDER BY host_id',
    [identity.accountId]
  )
  const choice = chooseMachine({
    hosts: rows.flatMap((row) => knownHost(row) ?? []),
    identity,
    channelId: message.channelId,
    text: route.text
  })
  if (choice.kind === 'no_machine') {
    await replyToWriter(
      deps.posts,
      transaction,
      message,
      `update:${messageKey}`,
      slackText.updateOrca
    )
    return
  }
  if (choice.kind === 'ask') {
    await replyToWriter(
      deps.posts,
      transaction,
      message,
      `ask:${messageKey}`,
      slackText.askPlace(choice.options)
    )
    return
  }
  // Partway through a thread, the start carries the thread so far: held until the start worker
  // reads it.
  await deliver(route, {
    externalId: route.externalId,
    hostId: choice.hostId,
    placeId: choice.placeId,
    body: { kind: 'start', agent: choice.agent, placeId: choice.placeId, prompt: route.text },
    held: message.ts !== message.threadTs
  })
}

// The owner's next message is a follow-up, or a fresh start on the same machine and project when
// the first one never reached the agent (offline, refused).
async function continueConversation(route: Route, thread: ThreadRow): Promise<void> {
  const { deps, transaction, message, messageKey } = route
  // Context is consumed only once there is a delivery to carry it.
  const prompt = () => withTeammateContext(transaction, thread.externalId, route.text, deps.now())
  if (await hasLiveStart(transaction, thread, deps.now())) {
    await deliver(route, { ...thread, body: { kind: 'send', text: await prompt() } })
    return
  }
  const [host] = await transaction.query(
    'SELECT host_id, host_name, hello FROM connector_hosts WHERE host_id = ?',
    [thread.hostId]
  )
  const agent = (host && knownHost(host))?.hello.agents.find((name) =>
    CONNECTOR_AGENTS.some((known) => known === name)
  )
  if (!agent) {
    await replyToWriter(
      deps.posts,
      transaction,
      message,
      `update:${messageKey}`,
      slackText.updateOrca
    )
    return
  }
  await deliver(route, {
    ...thread,
    body: { kind: 'start', agent, placeId: thread.placeId, prompt: await prompt() },
    // Like any start partway through a thread, it waits to carry the thread too.
    held: message.ts !== message.threadTs
  })
}

async function deliver(
  route: Route,
  target: {
    externalId: string
    hostId: string
    placeId: string
    body: DeliveryBody
    held?: boolean
  }
): Promise<void> {
  const { deps, transaction, message, messageKey, place } = route
  const queued = await deps.queue(transaction, {
    thread: {
      ...place,
      externalId: target.externalId,
      ownerUserId: message.userId,
      hostId: target.hostId,
      placeId: target.placeId
    },
    deliveryId: messageKey,
    body: target.body,
    held: target.held ?? false
  })
  if (queued !== 'queued') {
    return
  }
  await reactSeen(deps.posts, transaction, place, messageKey, message.ts)
  await refreshSlackStatus(transaction, deps.posts, target.hostId, target.externalId)
}

async function threadsIn(transaction: CloudDatabase, place: SlackPlace): Promise<ThreadRow[]> {
  const rows = await transaction.query(
    `SELECT external_id, owner_user_id, host_id, place_id, pane_key FROM connector_threads
     WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
    [place.teamId, place.channelId, place.threadTs]
  )
  return rows.map((row) => ({
    externalId: String(row.external_id),
    ownerUserId: String(row.owner_user_id),
    hostId: String(row.host_id),
    placeId: String(row.place_id),
    paneKey: row.pane_key === null ? null : String(row.pane_key)
  }))
}

// Linked on the machine, on its way there, or accepted by it.
async function hasLiveStart(
  transaction: CloudDatabase,
  thread: ThreadRow,
  now: number
): Promise<boolean> {
  if (thread.paneKey !== null) {
    return true
  }
  const [start] = await transaction.query(
    `SELECT state, result, expires_at FROM connector_inbox
     WHERE host_id = ? AND external_id = ? AND kind = 'start' ORDER BY seq DESC LIMIT 1`,
    [thread.hostId, thread.externalId]
  )
  if (start?.state === 'done') {
    return (
      ConnectorDeliveryResultSchema.safeParse(JSON.parse(String(start.result))).data?.outcome ===
      'accepted'
    )
  }
  // A pending or held start past its deadline will never go out, swept yet or not.
  if (start?.state === 'pending' || start?.state === 'held') {
    return Number(start.expires_at) > now
  }
  return start?.state === 'leased' || start?.state === 'received'
}
