import { createHash } from 'node:crypto'
import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  ConnectorDeliveryResultSchema,
  ConnectorPendingPromptSchema,
  type ConnectorConversation,
  type ConnectorHelloRequest,
  type ConnectorPendingPrompt
} from '@orca-cloud/connector-contract'
import { lockConnectorHost } from './connector-hosts.js'
import { conversationKey, threadPlace } from './connector-threads.js'
import type { QueueInTransaction } from './queue-delivery.js'

// What an owner can do to their conversation from any connected app: answer the agent's prompt
// (decisions §1: only the owner). It goes to the machine through the inbox.
export type OwnerAction = { kind: 'answer'; promptId: string; optionId: string }

export type OwnerActionOutcome =
  | { kind: 'not_owner'; ownerUserId: string }
  // The agent no longer shows that prompt, or it was already answered.
  | { kind: 'moved_on' }
  | { kind: 'answered'; ownerUserId: string; label: string }

// Where the owner's answer to the current prompt stands, read from its inbox row.
export type OwnerActionState =
  | { kind: 'on_its_way' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' }
  | { kind: 'unreached' }

export type AnswerablePrompt = Extract<ConnectorPendingPrompt, { kind: 'approval' | 'question' }>

// One answer per prompt, so repeated presses are inbox duplicates. Hashed, so any contract-valid
// conversation and prompt ids still make a delivery id within its 128 limit.
export const answerDeliveryId = (conversation: ConnectorConversation, promptId: string) =>
  `answer:${createHash('sha256')
    .update(`${conversation.source}\0${conversation.externalId}\0${promptId}`)
    .digest('hex')}`

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

// The owner's answer to this prompt, if they sent one: matched by its own delivery id, so a newer
// prompt starts clean.
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

// Decided under the host lock the machine's events are applied under, so the prompt read here is the
// one the machine last reported.
export async function applyOwnerAction(
  transaction: CloudDatabase,
  queue: QueueInTransaction,
  conversation: ConnectorConversation,
  actorUserId: string,
  action: OwnerAction
): Promise<OwnerActionOutcome | null> {
  const [found] = await transaction.query(
    'SELECT host_id, owner_user_id FROM connector_threads WHERE source = ? AND external_id = ?',
    conversationKey(conversation)
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
    'SELECT * FROM connector_threads WHERE source = ? AND external_id = ? AND host_id = ?',
    [...conversationKey(conversation), hostId]
  )
  if (!thread) {
    return { kind: 'moved_on' }
  }
  const target = {
    conversation,
    place: threadPlace(thread),
    ownerUserId,
    hostId,
    placeId: String(thread.place_id)
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
    deliveryId: answerDeliveryId(conversation, action.promptId),
    body: { kind: 'answer', promptId: action.promptId, optionId: action.optionId }
  })
  return queued === 'queued'
    ? { kind: 'answered', ownerUserId, label: option.label }
    : { kind: 'moved_on' }
}
