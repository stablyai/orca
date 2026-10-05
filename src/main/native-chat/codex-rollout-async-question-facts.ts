import type { NativeChatAsyncQuestionFact } from '../../shared/native-chat-async-questions'
import { nativeChatTranscriptAsyncQuestionFacts } from '../../shared/native-chat-async-question-facts'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import {
  codexUserRecordReplyText,
  parseCodexAsyncQuestionReplyIds
} from './codex-async-question-reply'

// Cheap prefilter: most rollout lines (tool output) cannot carry a fact and skip JSON parsing.
const FACT_MARKERS = ['user_message', 'UserMessage', '_async', '"async"'] as const

/** Only Codex's own user-message events count as delivered: injected context records
 *  (environment, instructions) are user-role response items but never these events. */
function deliveredUserPayload(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.type !== 'event_msg') {
    return null
  }
  const payload = asRecord(record.payload)
  if (payload?.type === 'user_message') {
    return payload
  }
  const item = payload?.type === 'item_completed' ? asRecord(payload.item) : null
  return item?.type === 'UserMessage' || item?.type === 'user_message' ? payload : null
}

/** A reply from Codex's question editor answers only the questions it names; any other
 *  delivered message clears the whole set, as Codex does for a typed prompt. */
function deliveredUserFacts(payload: Record<string, unknown>): NativeChatAsyncQuestionFact[] {
  const replyText = codexUserRecordReplyText(payload)
  const ids = replyText === null ? null : parseCodexAsyncQuestionReplyIds(replyText)
  return [ids ? { kind: 'answered', ids } : { kind: 'delivered-user-message', author: 'root' }]
}

/** Async-question facts of one rollout line, in record order. */
export function codexRolloutAsyncQuestionFacts(
  line: string,
  recordId: string
): NativeChatAsyncQuestionFact[] {
  if (!FACT_MARKERS.some((marker) => line.includes(marker))) {
    return []
  }
  const record = parseJsonObject(line)
  if (!record) {
    return []
  }
  const delivered = deliveredUserPayload(record)
  if (delivered) {
    return deliveredUserFacts(delivered)
  }
  const message = decodeCodexTranscriptLine(line, recordId)
  return message ? nativeChatTranscriptAsyncQuestionFacts(message) : []
}

/** Bytes of a record over the size cap still read, enough for its envelope and item type. */
export const CODEX_OVERSIZED_RECORD_HEAD_BYTES = 4096

const DELIVERED_USER_HEAD =
  /^\{(?:"timestamp":"[^"]*",)?"type":"event_msg","payload":\{"type":"(?:user_message"|item_completed",.*?"item":\{"type":"(?:UserMessage|user_message)")/

/** A record over the size cap is never parsed, but a pasted giant reply is still a delivered
 *  user message: its compact JSON head says so before any user text (which is escaped). */
export function codexOversizedRolloutRecordFacts(head: string): NativeChatAsyncQuestionFact[] {
  return DELIVERED_USER_HEAD.test(head) ? [{ kind: 'delivered-user-message', author: 'root' }] : []
}
