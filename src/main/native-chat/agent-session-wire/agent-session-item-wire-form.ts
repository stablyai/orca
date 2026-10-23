// One journal item as every client receives it.
//
// The journal keeps tool output and diffs whole. A client is sent a head of each and the item is
// marked `shortened`; it fetches the whole item with `agentSession.item` when the user asks. Every
// other field is sent as kept. An item still past a page is shortened to fit and marked
// rather than replaced, so its row and its "show full" stay readable.

import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import {
  boundToolInput,
  JOURNAL_RUNNING_PREVIEW_LIMITS,
  utf8Head
} from '../agent-session-journal/journal-payload-bounds'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  type HistoryItemForm,
  type HistoryReader
} from './agent-session-history-page-bounds'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'

/** Each tool output or diff as sent: the head older clients have always been sent. */
export const AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES = 16 * 1024

/** Preserve every ordinary message that already fits a desktop page. */
const CLIENT_ITEM_MAX_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES

/** The payload as sent; itself when its head already fits. */
function wirePayload(payload: AgentJournalBoundedPayload): AgentJournalBoundedPayload {
  // UTF-8 spends at most three bytes per UTF-16 unit, so most heads fit without encoding.
  if (
    payload.head.length * 3 <= AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES ||
    Buffer.byteLength(payload.head, 'utf8') <= AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES
  ) {
    return payload
  }
  return {
    ...payload,
    head: utf8Head(payload.head, AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES),
    truncated: true
  }
}

function wireBody(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'tool-call' && body.output) {
    const output = wirePayload(body.output)
    return output === body.output ? body : { ...body, output }
  }
  if (body.kind === 'diff') {
    const patch = wirePayload(body.patch)
    return patch === body.patch ? body : { ...body, patch }
  }
  return body
}

/** `item` fitted to `maxBytes`: its long strings shortened and the item marked. Null when even
 *  that cannot fit, which the page answers with its too-large marker. */
export function shortenedAgentJournalItem(
  item: AgentJournalRenderItem,
  maxBytes: number,
  bytes = jsonBytes(item)
): AgentJournalRenderItem | null {
  if (bytes <= maxBytes) {
    return item
  }
  const budget = maxBytes - (jsonBytes({ ...item, body: null, shortened: true }) - jsonBytes(null))
  let body = shortenJsonStringsToFit(item.body, budget)
  if (body === null && item.body.kind === 'tool-call') {
    body = shortenJsonStringsToFit(
      { ...item.body, input: boundToolInput(item.body.input, JOURNAL_RUNNING_PREVIEW_LIMITS) },
      budget
    )
  }
  return body === null ? null : { ...item, body, shortened: true }
}

function wireItem(item: AgentJournalRenderItem): HistoryItemForm {
  const body = wireBody(item.body)
  const sent = body === item.body ? item : { ...item, body, shortened: true as const }
  const bytes = jsonBytes(sent)
  const fitted = shortenedAgentJournalItem(sent, CLIENT_ITEM_MAX_BYTES, bytes) ?? sent
  return { item: fitted, bytes: fitted === sent ? bytes : jsonBytes(fitted) }
}

// Items are immutable per revision, so a catch-up or a second subscriber reuses the sent form.
const sentForms = new WeakMap<AgentJournalRenderItem, HistoryItemForm>()

/** What a client is sent of `item`. */
export function agentJournalItemForWire(item: AgentJournalRenderItem): HistoryItemForm {
  let sent = sentForms.get(item)
  if (sent === undefined) {
    sent = wireItem(item)
    sentForms.set(item, sent)
  }
  return sent
}

/** How a desktop or paired client reads history: each item in its sent form. */
export const CLIENT_HISTORY_READER: HistoryReader = {
  form: agentJournalItemForWire,
  budgetBytes: HISTORY_PAGE_CONTENT_BUDGET_BYTES
}
