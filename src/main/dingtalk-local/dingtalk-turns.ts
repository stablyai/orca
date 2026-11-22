import {
  stableReplyId,
  stableSendUuid,
  type ConversationRow,
  type DingTalkExternalId,
  type DingTalkLedgerState,
  type ReplyRow
} from './dingtalk-domain'

export type TurnObservation = {
  kind: 'turn-ended'
  source: string
  externalId: string
  turnId: number | null
  origin?: string
  lastAssistantMessage?: string
  /** The delivery that alone started this turn, from its turn-started event. */
  deliveryId?: string
}

export type TurnAttribution =
  | { kind: 'reply'; reply: ReplyRow; inboxKeys: string[] }
  | {
      kind: 'ignore'
      reason:
        | 'wrong_source'
        | 'not_delivery'
        | 'missing_turn'
        | 'missing_text'
        | 'conversation_missing'
        | 'already_replied'
    }

export function attributeTurnEnded(
  state: DingTalkLedgerState,
  event: TurnObservation,
  now = Date.now()
): TurnAttribution {
  if (event.source !== 'dingtalk') {
    return { kind: 'ignore', reason: 'wrong_source' }
  }
  if (event.origin !== 'delivery') {
    return { kind: 'ignore', reason: 'not_delivery' }
  }
  if (event.turnId === null) {
    return { kind: 'ignore', reason: 'missing_turn' }
  }
  const text = event.lastAssistantMessage?.trim()
  if (!text) {
    return { kind: 'ignore', reason: 'missing_text' }
  }
  const conversation = state.conversations[event.externalId]
  if (!conversation) {
    return { kind: 'ignore', reason: 'conversation_missing' }
  }
  const replyKey = stableReplyId(conversation.externalId, event.turnId)
  // A repeated completion must not attribute a newer delivered row to an older turn's reply.
  if (state.replies[replyKey]) {
    return { kind: 'ignore', reason: 'already_replied' }
  }
  const reply: ReplyRow = {
    key: replyKey,
    externalId: conversation.externalId,
    profile: conversation.profile,
    groupId: conversation.groupId,
    text,
    uuid: stableSendUuid(replyKey),
    turnId: event.turnId,
    state: 'queued',
    error: '',
    updatedAt: now
  }
  return { kind: 'reply', reply, inboxKeys: answeredInboxKeys(state, event) }
}

/** The messages a turn answered: the one delivery that started it, else every message of the
 *  conversation still in flight, since a busy chat folds those into its running turn. */
function answeredInboxKeys(state: DingTalkLedgerState, event: TurnObservation): string[] {
  const rows = Object.values(state.inbox).filter((row) => row.externalId === event.externalId)
  const started = event.deliveryId && rows.find((row) => row.deliveryId === event.deliveryId)
  if (started) {
    return [started.key]
  }
  return rows
    .filter((row) => row.state === 'delivered' || row.state === 'delivering')
    .map((row) => row.key)
}

/** Remembers which delivery alone started each turn, until that turn ends. */
export class DingTalkTurnDeliveries {
  private readonly started = new Map<string, string>()

  start(externalId: string, at: number, deliveryId: string | undefined): void {
    if (deliveryId) {
      this.started.set(`${externalId}\u0000${at}`, deliveryId)
    }
  }

  end(externalId: string, turnId: number | null): string | undefined {
    const key = `${externalId}\u0000${turnId}`
    const deliveryId = this.started.get(key)
    this.started.delete(key)
    return deliveryId
  }
}

export function conversationKeyFor(row: ConversationRow): {
  source: 'dingtalk'
  externalId: DingTalkExternalId
} {
  return { source: 'dingtalk', externalId: row.externalId }
}
