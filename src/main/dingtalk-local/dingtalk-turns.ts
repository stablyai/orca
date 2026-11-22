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
}

export type TurnAttribution =
  | { kind: 'reply'; reply: ReplyRow; inboxKey: string }
  | {
      kind: 'ignore'
      reason:
        | 'wrong_source'
        | 'not_delivery'
        | 'missing_turn'
        | 'missing_text'
        | 'conversation_missing'
        | 'ambiguous_inbox'
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
  const candidates = Object.entries(state.inbox).filter(
    ([, row]) => row.externalId === event.externalId && row.state === 'delivered'
  )
  if (candidates.length !== 1) {
    return { kind: 'ignore', reason: 'ambiguous_inbox' }
  }
  const [inboxKey] = candidates[0]!
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
  return { kind: 'reply', reply, inboxKey }
}

export function conversationKeyFor(row: ConversationRow): {
  source: 'dingtalk'
  externalId: DingTalkExternalId
} {
  return { source: 'dingtalk', externalId: row.externalId }
}
