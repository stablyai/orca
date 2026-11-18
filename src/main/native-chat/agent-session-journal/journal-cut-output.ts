import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { digestPayload } from './item-lifecycle/journal-payload-bounds'

/** A saved item read shortened: its tool output or patch, cut to a head but still naming its whole text. */
export function cutJournalOutput(
  saved: AgentJournalRenderItem | null | undefined
): AgentJournalBoundedPayload | undefined {
  if (!saved?.shortened) {
    return undefined
  }
  const payload = savedPayload(saved.body)
  return payload?.truncated ? payload : undefined
}

/** Whether `text` is the whole text a cut payload was taken from. */
export function isCutJournalOutputOf(cut: AgentJournalBoundedPayload, text: unknown): boolean {
  return (
    typeof text === 'string' &&
    text.length * 3 >= cut.byteLength &&
    Buffer.byteLength(text, 'utf8') === cut.byteLength &&
    digestPayload(text) === cut.digest
  )
}

/**
 * A write handed a cut of the output its row already holds whole (same size and digest) keeps
 * the whole text, so a shortened read never replaces it with its head.
 */
export function restoreCutJournalOutput(
  db: Database.Database,
  prefix: readonly [string, string],
  item: AgentJournalRenderItem,
  previous?: AgentJournalRenderItem
): AgentJournalRenderItem {
  const { body } = item
  const payload = savedPayload(body)
  if (
    !payload?.truncated ||
    (body.kind === 'tool-call' && body.state === 'running') ||
    Buffer.byteLength(payload.head, 'utf8') >= payload.byteLength
  ) {
    return item
  }
  // A writer that already loaded the row whole restores from it, without reading it again.
  const held = previous && savedPayload(previous.body)
  if (
    held &&
    !held.truncated &&
    held.digest === payload.digest &&
    held.byteLength === payload.byteLength
  ) {
    return withWholeOutput(item, held)
  }
  // The row may hold it under the other field: a diff becomes a Diff call and back.
  const whole = (
    field: string
  ) => `CASE WHEN json_extract(payload_json,'$.body.${field}.truncated')=0
    AND json_extract(payload_json,'$.body.${field}.digest')=?
    AND json_extract(payload_json,'$.body.${field}.byteLength')=?
    THEN json(json_extract(payload_json,'$.body.${field}')) END`
  const row = db
    .prepare(`SELECT COALESCE(${whole('output')}, ${whole('patch')}) AS whole FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND output_blob IS NULL`)
    .get(
      payload.digest,
      payload.byteLength,
      payload.digest,
      payload.byteLength,
      ...prefix,
      item.itemId
    )
  if (typeof row?.whole !== 'string') {
    return item
  }
  const saved: AgentJournalBoundedPayload = JSON.parse(row.whole)
  return withWholeOutput(item, saved)
}

function withWholeOutput(
  item: AgentJournalRenderItem,
  whole: AgentJournalBoundedPayload
): AgentJournalRenderItem {
  const { body } = item
  const restored: AgentJournalRenderItem = {
    ...item,
    body:
      body.kind === 'diff'
        ? { ...body, patch: whole }
        : body.kind === 'tool-call'
          ? { ...body, output: whole }
          : body
  }
  delete restored.shortened
  return restored
}

/** `item` with the tool output or patch of `from`, under whichever field `item`'s kind holds it. */
export function withJournalOutputOf(
  item: AgentJournalRenderItem,
  from: AgentJournalRenderItem
): AgentJournalRenderItem {
  const payload = savedPayload(from.body)
  const { body } = item
  return !payload
    ? item
    : body.kind === 'diff'
      ? { ...item, body: { ...body, patch: payload } }
      : body.kind === 'tool-call'
        ? { ...item, body: { ...body, output: payload } }
        : item
}

function savedPayload(body: AgentJournalItemBody): AgentJournalBoundedPayload | undefined {
  return body.kind === 'tool-call' ? body.output : body.kind === 'diff' ? body.patch : undefined
}
