import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_AGENTS,
  ConnectorDeliveryResultSchema,
  type ConnectorConversation
} from '@orca-cloud/connector-contract'
import type { InboundMessage, Notice, ThreadPlace } from './connector-adapter.js'
import { findIdentity } from './connector-identities.js'
import type { DeliveryBody } from './connector-inbox.js'
import { conversationKey } from './connector-threads.js'
import { chooseMachine, knownHost } from './machine-choice.js'
import type { QueueInTransaction } from './queue-delivery.js'
import { keepTeammateContext, withTeammateContext } from './teammate-context.js'
import type { ThreadPosts } from './thread-posts.js'

export type RoutingDeps = {
  queue: QueueInTransaction
  threadPosts: ThreadPosts
  now: () => number
}

type ThreadRow = {
  conversation: ConnectorConversation
  ownerUserId: string
  hostId: string
  placeId: string
  paneKey: string | null
}

// Decisions §1: only a conversation's owner starts or steers it; anyone else's message in the thread
// is kept as context for the owner's next turn, and a new mention by them starts their own.
export async function routeMessage(
  deps: RoutingDeps,
  transaction: CloudDatabase,
  message: InboundMessage
): Promise<void> {
  const { source, place, messageId, authorId } = message
  const messageKey = `${place.workspaceId}:${place.containerId}:${messageId}`
  // A source may send one message more than once (Slack: message and app_mention, and retries).
  const [seen] = await transaction.query(
    `INSERT INTO connector_seen (source, message_key, seen_at) VALUES (?, ?, ?)
     ON CONFLICT (source, message_key) DO NOTHING`,
    [source, messageKey, deps.now()]
  )
  if (Number(seen?.changes ?? 0) === 0) {
    return
  }
  // Serializes routing per thread, so two quick messages can't both start a conversation.
  await transaction.lockQuotaScope(
    `orca-connector-thread:${source}:${place.workspaceId}:${place.containerId}:${place.threadId}`
  )
  const threads = await threadsIn(transaction, source, place)
  const own = threads.find((thread) => thread.ownerUserId === authorId)
  const conversation = {
    source,
    externalId: `${place.workspaceId}:${place.containerId}:${place.threadId}:${authorId}`
  }
  const othersConversations = threads
    .filter((thread) => thread.ownerUserId !== authorId)
    .map((thread) => thread.conversation)
  const addressed = own !== undefined || message.mentioned
  if (!addressed && othersConversations.length === 0) {
    return
  }
  const route: Route = { deps, transaction, message, messageKey, conversation }
  // Paused input is neither delivered nor kept for later.
  if (message.paused) {
    if (addressed) {
      await notify(
        route,
        `paused:${place.workspaceId}:${place.containerId}:${place.threadId}:${authorId}`,
        { kind: 'paused' }
      )
    }
    return
  }
  if (message.text.length === 0) {
    return
  }
  // Context for every other owner's conversation here, whatever this message does for its author.
  for (const other of othersConversations) {
    await keepTeammateContext(
      transaction,
      other,
      {
        messageId,
        workspaceId: place.workspaceId,
        authorId,
        authorName: message.authorName,
        text: message.text
      },
      deps.now()
    )
  }
  if (!addressed) {
    return
  }
  await (own ? continueConversation(route, own) : startConversation(route))
}

type Route = {
  deps: RoutingDeps
  transaction: CloudDatabase
  message: InboundMessage
  messageKey: string
  conversation: ConnectorConversation
}

// Meant only for the person who wrote.
async function notify(route: Route, postId: string, notice: Notice): Promise<void> {
  const { message } = route
  await route.deps.threadPosts.notify(
    route.transaction,
    {
      place: message.place,
      userId: message.authorId,
      direct: message.direct,
      messageId: message.messageId
    },
    postId,
    notice
  )
}

async function startConversation(route: Route): Promise<void> {
  const { transaction, message, messageKey } = route
  const identity = await findIdentity(transaction, {
    source: message.source,
    workspaceId: message.place.workspaceId,
    userId: message.authorId
  })
  if (!identity) {
    await notify(route, `unlinked:${messageKey}`, { kind: 'unlinked' })
    return
  }
  const rows = await transaction.query(
    'SELECT host_id, host_name, hello FROM connector_hosts WHERE account_id = ? ORDER BY host_id',
    [identity.accountId]
  )
  const choice = chooseMachine({
    source: message.source,
    hosts: rows.flatMap((row) => knownHost(row) ?? []),
    identity,
    containerId: message.place.containerId,
    text: message.text
  })
  if (choice.kind === 'no_machine') {
    await notify(route, `update:${messageKey}`, { kind: 'update' })
    return
  }
  if (choice.kind === 'ask') {
    await notify(route, `ask:${messageKey}`, { kind: 'ask', options: choice.options })
    return
  }
  // Partway through a thread, the start carries the thread so far: held until the start worker
  // reads it.
  await deliver(route, {
    hostId: choice.hostId,
    placeId: choice.placeId,
    body: { kind: 'start', agent: choice.agent, placeId: choice.placeId, prompt: message.text },
    held: message.messageId !== message.place.threadId
  })
}

// The owner's next message is a follow-up, or a fresh start on the same machine and project when
// the first one never reached the agent (offline, refused).
async function continueConversation(route: Route, thread: ThreadRow): Promise<void> {
  const { deps, transaction, message, messageKey } = route
  // Context is consumed only once there is a delivery to carry it.
  const prompt = () =>
    withTeammateContext(
      transaction,
      deps.threadPosts.adapter,
      { ...thread.conversation, workspaceId: message.place.workspaceId },
      message.text
    )
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
    await notify(route, `update:${messageKey}`, { kind: 'update' })
    return
  }
  await deliver(route, {
    ...thread,
    body: { kind: 'start', agent, placeId: thread.placeId, prompt: await prompt() },
    // Like any start partway through a thread, it waits to carry the thread too.
    held: message.messageId !== message.place.threadId
  })
}

async function deliver(
  route: Route,
  target: Pick<ThreadRow, 'hostId' | 'placeId'> & { body: DeliveryBody; held?: boolean }
): Promise<void> {
  const { deps, transaction, message, messageKey, conversation } = route
  const queued = await deps.queue(transaction, {
    thread: {
      conversation,
      place: message.place,
      ownerUserId: message.authorId,
      hostId: target.hostId,
      placeId: target.placeId
    },
    // Unique per host across sources, as acknowledgements name a delivery by id alone.
    deliveryId: `${message.source}:${messageKey}`,
    messageId: message.messageId,
    body: target.body,
    held: target.held ?? false
  })
  if (queued !== 'queued') {
    return
  }
  await deps.threadPosts.acknowledge(transaction, message.place, messageKey, message.messageId)
  await deps.threadPosts.refresh(transaction, target.hostId, conversation.externalId)
}

async function threadsIn(
  transaction: CloudDatabase,
  source: InboundMessage['source'],
  place: ThreadPlace
): Promise<ThreadRow[]> {
  const rows = await transaction.query(
    `SELECT external_id, owner_user_id, host_id, place_id, pane_key FROM connector_threads
     WHERE source = ? AND workspace_id = ? AND container_id = ? AND thread_id = ?`,
    [source, place.workspaceId, place.containerId, place.threadId]
  )
  return rows.map((row) => ({
    conversation: { source, externalId: String(row.external_id) },
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
     WHERE host_id = ? AND source = ? AND external_id = ? AND kind = 'start'
     ORDER BY seq DESC LIMIT 1`,
    [thread.hostId, ...conversationKey(thread.conversation)]
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
