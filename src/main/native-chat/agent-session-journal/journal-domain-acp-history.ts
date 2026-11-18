import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { providerTimelineKeyPart } from '../agent-session-timeline/provider-timeline-identity'
import {
  acpHistoryHasOutput,
  acpPromptDigest,
  type AcpNativeTurn
} from '../../acp/history/acp-history-turn-content'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalCanonicalItemId, journalVisibleItem } from './journal-sql-item-reads'
import { ITEMS_BY_KIND_PAGE_JSON_BUDGET } from './journal-items-by-kind-page'
import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'
import { measureJournalStoredRow } from './journal-stored-output-rows'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalAcpHistoryRead = {
  kind: 'acp-history'
  agent: string
  sessionId: string
  providerSessionId: string
  /** Saved rows whose placement coverage matching needs. */
  itemIds: readonly string[]
}

export type JournalAcpHistory = {
  /** The chat's own lifecycle rows in the provider session's turn namespace. */
  turns: { itemId: string; userItemId: string | null }[]
  natives: AcpNativeTurn[]
  /** Rows adopted from the provider session, by record ID. */
  adopted: [recordId: string, sequence: number][]
  held: { itemId: string; turnItemId: string | null }[]
}

export type JournalAcpHistoryItemsRead = { kind: 'acp-history-items'; itemIds: readonly string[] }

export type JournalAcpHistoryItems = {
  items: AgentJournalRenderItem[]
  canonical: [itemId: string, canonicalItemId: string][]
  /** How many leading `itemIds` this page answered. */
  consumed: number
}

/** The kinds ACP catch-up reads; every kind but Orca cards. */
const KINDS = `('message','tool-call','diff','approval','question','status','turn')`

/** Turn facts, adoption sequences and placements only; no saved output leaves the reader. */
export function readJournalDomainAcpHistory(
  scope: JournalSqlScope,
  read: JournalAcpHistoryRead
): JournalAcpHistory {
  const { db, prefix } = scope
  const namespace = `p:${providerTimelineKeyPart(read.providerSessionId)}:`
  const turns: JournalAcpHistory['turns'] = []
  const natives: AcpNativeTurn[] = []
  const scoped =
    db.prepare(`SELECT item_id,kind FROM journal_items INDEXED BY journal_items_stop_turn
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_item_id=? AND kind IN ${KINDS}`)
  for (const row of db
    .prepare(`SELECT item_id,sequence,turn_id,opener_item_id FROM journal_items
    INDEXED BY journal_items_named_turn
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id IS NOT NULL AND turn_id>=? AND turn_id<?
    ORDER BY ordinal`)
    .iterate(...prefix, namespace, `${namespace.slice(0, -1)};`)) {
    const itemId = String(row.item_id)
    const identity = parseAgentJournalItemKey(itemId)
    if (
      identity?.provider !== 'legacy' ||
      identity.agent !== read.agent ||
      identity.sessionId !== read.sessionId
    ) {
      continue
    }
    const userItemId = row.opener_item_id ? String(row.opener_item_id) : null
    turns.push({ itemId, userItemId })
    if (
      !userItemId ||
      parseAgentJournalItemKey(userItemId)?.provider !== 'orca' ||
      identity.recordId !== `turn-lifecycle:${String(row.turn_id)}`
    ) {
      continue
    }
    const user = journalVisibleItem(db, prefix, userItemId)?.body
    let output = false
    for (const item of scoped.iterate(...prefix, itemId)) {
      output =
        item.kind === 'message'
          ? acpHistoryHasOutput(journalVisibleItem(db, prefix, String(item.item_id))!.body)
          : item.kind !== 'turn'
      if (output) {
        break
      }
    }
    natives.push({
      itemId,
      sequence: Number(row.sequence),
      output,
      text: user?.kind === 'message' && !user.command ? acpPromptDigest(user.blocks) : null
    })
  }
  const adoptedPrefix = agentJournalItemKey({
    provider: 'legacy',
    agent: read.agent,
    sessionId: read.providerSessionId,
    recordId: ''
  })
  const adopted: JournalAcpHistory['adopted'] = []
  for (const row of db
    .prepare(`SELECT item_id,sequence FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id>=? AND item_id<? AND hidden=0 AND kind IN ${KINDS}
    ORDER BY ordinal`)
    .iterate(...prefix, adoptedPrefix, `${adoptedPrefix.slice(0, -1)};`)) {
    const identity = parseAgentJournalItemKey(String(row.item_id))
    if (
      identity?.provider === 'legacy' &&
      identity.agent === read.agent &&
      identity.sessionId === read.providerSessionId
    ) {
      adopted.push([identity.recordId, Number(row.sequence)])
    }
  }
  const placement = db.prepare(`SELECT turn_item_id FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND kind IN ${KINDS}`)
  const held = read.itemIds.flatMap((itemId) => {
    const row = placement.get(...prefix, itemId)
    return row ? [{ itemId, turnItemId: row.turn_item_id ? String(row.turn_item_id) : null }] : []
  })
  return { turns, natives: natives.toSorted((a, b) => a.sequence - b.sequence), adopted, held }
}

/** Saved rows by key, paged and shortened as an item visit reads them; a lone larger row still goes. */
export function readJournalDomainAcpHistoryItems(
  scope: JournalSqlScope,
  itemIds: readonly string[]
): JournalAcpHistoryItems {
  const { db, prefix } = scope
  const canonicalOf = journalCanonicalItemId(db, prefix)
  const payload =
    db.prepare(`SELECT ${boundedStoredJsonSql('payload_json', 'payload_json', { shortenColumn: 'payload_json' })},
    output_blob FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
  const items: AgentJournalRenderItem[] = []
  const canonical: JournalAcpHistoryItems['canonical'] = []
  let used = 0
  for (const itemId of itemIds) {
    const row = payload.get(...prefix, itemId)
    if (row) {
      const { bytes, item } = measureJournalStoredRow(db, prefix, {
        payload_json: boundedStoredJson(row, 'payload_json'),
        output_blob: row.output_blob
      })
      if (items.length > 0 && used + bytes > ITEMS_BY_KIND_PAGE_JSON_BUDGET) {
        break
      }
      used += bytes
      items.push(item())
    }
    canonical.push([itemId, canonicalOf(itemId)])
  }
  return { items, canonical, consumed: canonical.length }
}
