// Send bounded tool/diff heads with shortened markers; agentSession.item retrieves full stored content.
// Shorten other oversized content visibly while retaining row identity and full-content access.

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

export const AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES = 16 * 1024

const CLIENT_ITEM_MAX_BYTES = HISTORY_PAGE_CONTENT_BUDGET_BYTES

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

/** Shorten visibly to fit; null means the page must use an oversized-item marker. */
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

// Revision objects are immutable, so readers/subscribers may reuse wire forms.
const sentForms = new WeakMap<AgentJournalRenderItem, HistoryItemForm>()

export function agentJournalItemForWire(item: AgentJournalRenderItem): HistoryItemForm {
  let sent = sentForms.get(item)
  if (sent === undefined) {
    sent = wireItem(item)
    sentForms.set(item, sent)
  }
  return sent
}

export const CLIENT_HISTORY_READER: HistoryReader = {
  form: agentJournalItemForWire,
  budgetBytes: HISTORY_PAGE_CONTENT_BUDGET_BYTES
}
