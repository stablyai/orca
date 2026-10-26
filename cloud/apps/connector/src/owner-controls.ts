import { createHash } from 'node:crypto'
import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  ConnectorDeliveryResultSchema,
  ConnectorHelloRequestSchema,
  ConnectorPendingPromptSchema,
  type ConnectorHelloRequest,
  type ConnectorPendingPrompt
} from '@orca-cloud/connector-contract'
import { lockConnectorHost } from './connector-hosts.js'
import type { QueueInTransaction } from './queue-delivery.js'

// What an owner can do to their conversation from any connected app: answer the agent's prompt,
// or stop its turn (decisions §1: only the owner). Each goes to the machine through the inbox.
export type OwnerAction =
  | { kind: 'answer'; promptId: string; optionId: string }
  | { kind: 'stop'; turnId: number }

export type OwnerActionOutcome =
  | { kind: 'not_owner'; ownerUserId: string }
  // The agent no longer shows that prompt or runs that turn, or it was already done once.
  | { kind: 'moved_on' }
  | { kind: 'answered'; ownerUserId: string; label: string }
  | { kind: 'stopping' }

// Where an owner action for the current prompt or turn stands, read from its inbox row.
export type OwnerActionState =
  | { kind: 'on_its_way' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' }
  | { kind: 'unreached' }

export type AnswerablePrompt = Extract<ConnectorPendingPrompt, { kind: 'approval' | 'question' }>

// One answer per prompt, one stop per turn, so repeated presses are inbox duplicates. Hashed, so
// any contract-valid conversation and prompt ids still make a delivery id within its 128 limit.
const actionDeliveryId = (action: 'answer' | 'stop', externalId: string, target: string) =>
  `${action}:${createHash('sha256').update(`${externalId}\0${target}`).digest('hex')}`
export const answerDeliveryId = (externalId: string, promptId: string) =>
  actionDeliveryId('answer', externalId, promptId)
export const stopDeliveryId = (externalId: string, turnId: number) =>
  actionDeliveryId('stop', externalId, String(turnId))

export function pendingPrompt(thread: SqlRow): ConnectorPendingPrompt | undefined {
  return typeof thread.pending_prompt === 'string'
    ? ConnectorPendingPromptSchema.safeParse(JSON.parse(thread.pending_prompt)).data
    : undefined
}

// The thread's pending prompt when its machine takes answers of that kind.
export function answerablePrompt(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): AnswerablePrompt | null {
  const prompt = pendingPrompt(thread)
  return prompt &&
    prompt.kind !== 'unsupported' &&
    hello?.features.includes('answer') &&
    hello.promptKinds.includes(prompt.kind)
    ? prompt
    : null
}

// The open turn, when its machine refuses a cancel for any other turn (`turnCancel`): an older one
// would apply a late Stop to whatever turn runs by then.
export function stoppableTurn(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): number | null {
  return thread.turn_state === 'working' &&
    thread.open_turn_id !== null &&
    hello?.features.includes('turnCancel')
    ? Number(thread.open_turn_id)
    : null
}

// The answer to this prompt or the stop for this turn, if the owner sent one: matched by its own
// delivery id, so a newer prompt or turn starts clean.
export async function ownerActionState(
  transaction: CloudDatabase,
  hostId: string,
  deliveryId: string
): Promise<OwnerActionState | null> {
  const [row] = await transaction.query(
    'SELECT state, result FROM connector_inbox WHERE host_id = ? AND delivery_id = ?',
    [hostId, deliveryId]
  )
  if (!row) {
    return null
  }
  if (row.state === 'expired') {
    return { kind: 'unreached' }
  }
  if (row.state !== 'done') {
    return { kind: 'on_its_way' }
  }
  const result = ConnectorDeliveryResultSchema.safeParse(JSON.parse(String(row.result))).data
  switch (result?.outcome) {
    case 'accepted':
      return { kind: 'on_its_way' }
    case 'refused':
      return { kind: 'refused', reason: result.reason }
    case 'expired':
      return { kind: 'unreached' }
    default:
      return { kind: 'unknown' }
  }
}

// Under the host lock that applied a machine's events: a Stop not yet received for a turn that is
// no longer the open one never goes out. Received ones are the machine's to refuse.
export async function retireStaleStops(
  transaction: CloudDatabase,
  hostId: string,
  now: number
): Promise<void> {
  const stops = await transaction.query(
    `SELECT i.delivery_id, i.payload, t.turn_state, t.open_turn_id FROM connector_inbox i
     JOIN connector_threads t ON t.external_id = i.external_id AND t.host_id = i.host_id
     WHERE i.host_id = ? AND i.kind = 'cancel' AND i.state IN ('pending', 'leased')`,
    [hostId]
  )
  for (const stop of stops) {
    const turnId: unknown = JSON.parse(String(stop.payload)).turnId
    const current = stop.turn_state === 'working' && Number(stop.open_turn_id) === turnId
    if (typeof turnId === 'number' && !current) {
      await transaction.query(
        `UPDATE connector_inbox SET state = 'dropped', payload = NULL, settled_at = ?
         WHERE host_id = ? AND delivery_id = ? AND state IN ('pending', 'leased')`,
        [now, hostId, stop.delivery_id]
      )
    }
  }
}

// Decided under the host lock the machine's events are applied under, so the prompt and turn read
// here are the ones the machine last reported.
export async function applyOwnerAction(
  transaction: CloudDatabase,
  queue: QueueInTransaction,
  externalId: string,
  actorUserId: string,
  action: OwnerAction
): Promise<OwnerActionOutcome | null> {
  const [found] = await transaction.query(
    'SELECT host_id, owner_user_id FROM connector_threads WHERE external_id = ?',
    [externalId]
  )
  if (!found) {
    return null
  }
  const ownerUserId = String(found.owner_user_id)
  if (actorUserId !== ownerUserId) {
    return { kind: 'not_owner', ownerUserId }
  }
  const hostId = String(found.host_id)
  await lockConnectorHost(transaction, hostId)
  const [thread] = await transaction.query(
    'SELECT * FROM connector_threads WHERE external_id = ? AND host_id = ?',
    [externalId, hostId]
  )
  if (!thread) {
    return { kind: 'moved_on' }
  }
  const target = {
    externalId,
    teamId: String(thread.team_id),
    channelId: String(thread.channel_id),
    threadTs: String(thread.thread_ts),
    ownerUserId,
    hostId,
    placeId: String(thread.place_id)
  }
  if (action.kind === 'stop') {
    const [host] = await transaction.query('SELECT hello FROM connector_hosts WHERE host_id = ?', [
      hostId
    ])
    const hello = ConnectorHelloRequestSchema.safeParse(JSON.parse(String(host?.hello ?? 'null')))
    if (stoppableTurn(thread, hello.data) !== action.turnId) {
      return { kind: 'moved_on' }
    }
    const queued = await queue(transaction, {
      thread: target,
      deliveryId: stopDeliveryId(externalId, action.turnId),
      body: { kind: 'cancel', turnId: action.turnId }
    })
    return queued === 'queued' ? { kind: 'stopping' } : { kind: 'moved_on' }
  }
  const prompt = pendingPrompt(thread)
  const option =
    prompt?.kind !== 'unsupported' && prompt?.promptId === action.promptId
      ? prompt.options.find((candidate) => candidate.id === action.optionId)
      : undefined
  if (!option) {
    return { kind: 'moved_on' }
  }
  const queued = await queue(transaction, {
    thread: target,
    deliveryId: answerDeliveryId(externalId, action.promptId),
    body: { kind: 'answer', promptId: action.promptId, optionId: action.optionId }
  })
  return queued === 'queued'
    ? { kind: 'answered', ownerUserId, label: option.label }
    : { kind: 'moved_on' }
}
