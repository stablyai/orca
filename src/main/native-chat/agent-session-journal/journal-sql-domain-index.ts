import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalInputDomainStorage } from './journal-index-storage'
import {
  queryInputContext,
  type JournalInputCard,
  type JournalInputContext
} from './journal-input-lineage'
import {
  mergeInputPlaces,
  type InputPlaceQuery,
  type JournalInputPlaceEntry
} from './journal-input-place-index'
import {
  compareJournalSqlPlaces,
  journalSqlCardFlags,
  journalSqlEntryCard,
  journalSqlEntryFlags,
  journalSqlPlaceSummary
} from './journal-sql-place-index'
import type { JournalSqlScope } from './journal-sql-scope'
import type { QueuedMessageRow } from './queued-message-table'

/** The same introduction-prefix decomposition as the memory index, with SQL block ranges. */
export class JournalSqlDomainIndex implements JournalInputDomainStorage {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {}

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  clear(): void {
    this.scope.forget(`domains:${this.indexId}`)
    this.scope.db
      .prepare(
        'DELETE FROM journal_proj_domains WHERE session_id=? AND generation=? AND index_id=?'
      )
      .run(...this.prefix)
  }

  set(
    card: QueuedMessageRow,
    source: JournalInputCard,
    actionable: boolean,
    handoff: boolean
  ): void {
    this.change(card, source, actionable, handoff, false)
  }

  importEntry(introduced: number, entry: JournalInputPlaceEntry): void {
    const card = journalSqlEntryCard(entry)
    this.scope.db
      .prepare(`INSERT INTO journal_proj_domains
        (session_id, generation, index_id, id, introduced, domain, sequence, position,
         head, command, waiting, handoff, card_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.prefix,
        entry.id,
        introduced,
        entry.domain ?? '',
        entry.sequence,
        entry.position,
        ...journalSqlEntryFlags(entry),
        card ? this.scope.encode(card, `domains:${this.indexId}`, entry.id) : null
      )
  }

  setPosition(card: QueuedMessageRow, source: JournalInputCard): void {
    this.change(card, source, false, false, true)
  }

  delete(card: QueuedMessageRow, source: JournalInputCard): void {
    if (source.baseline) {
      this.scope.forget(`domains:${this.indexId}`, card.messageId)
      this.scope.db
        .prepare(`DELETE FROM journal_proj_domains
          WHERE session_id=? AND generation=? AND index_id=? AND id=?`)
        .run(...this.prefix, card.messageId)
    }
  }

  private change(
    card: QueuedMessageRow,
    source: JournalInputCard,
    actionable: boolean,
    handoff: boolean,
    positionOnly: boolean
  ): void {
    if (!source.baseline) {
      return
    }
    if (card.state === 'withdrawn') {
      this.delete(card, source)
      return
    }
    const flags = positionOnly ? [0, 0, 0, 0] : journalSqlCardFlags(card, actionable, handoff)
    const result = this.scope.db
      .prepare(`INSERT INTO journal_proj_domains
        (session_id, generation, index_id, id, introduced, domain, sequence, position,
         head, command, waiting, handoff, card_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, generation, index_id, id) DO UPDATE SET
          introduced=excluded.introduced, domain=excluded.domain, sequence=excluded.sequence,
          position=excluded.position, head=excluded.head, command=excluded.command,
          waiting=excluded.waiting, handoff=excluded.handoff, card_json=excluded.card_json
        ${
          positionOnly
            ? `WHERE introduced<>excluded.introduced OR domain<>excluded.domain
          OR sequence<>excluded.sequence OR position<>excluded.position`
            : ''
        }`)
      .run(
        ...this.prefix,
        card.messageId,
        Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - 1, source.introduced)),
        source.baseline.coordinate?.epoch ?? '',
        source.baseline.coordinate?.sequence ?? 0,
        card.position,
        ...flags,
        flags.some(Boolean)
          ? this.scope.encode(card, `domains:${this.indexId}`, card.messageId)
          : null
      )
    if (result.changes && !flags.some(Boolean)) {
      this.scope.forget(`domains:${this.indexId}`, card.messageId)
    }
  }

  query(context: JournalInputContext, original?: AgentJournalCursor): InputPlaceQuery {
    let result: InputPlaceQuery = { position: -Infinity }
    for (const [low, high] of introductionBlocks(context.cut)) {
      const block = queryInputContext(
        context,
        original,
        (coordinate) => this.block(low, high, coordinate),
        () => this.block(low, high),
        mergeInputPlaces
      )
      result = mergeInputPlaces(result, block)
    }
    return result
  }

  private block(low: number, high: number, coordinate?: AgentJournalCursor): InputPlaceQuery {
    const rows = this.scope.db
      .prepare(`SELECT id, domain, sequence, position, head, command, waiting, handoff, card_json
        FROM journal_proj_domains WHERE session_id=? AND generation=? AND index_id=?
        AND introduced>=? AND introduced<?`)
      .all(...this.prefix, low, high)
    rows.forEach((row) => this.scope.examined(row))
    rows.sort(compareJournalSqlPlaces)
    let result: InputPlaceQuery = { position: -Infinity }
    for (const row of rows) {
      if (
        coordinate &&
        (row.domain !== coordinate.epoch || Number(row.sequence) >= coordinate.sequence)
      ) {
        continue
      }
      result = mergeInputPlaces(result, journalSqlPlaceSummary(this.scope, row))
    }
    return result
  }
}

function introductionBlocks(cut: number): [number, number][] {
  const blocks: [number, number][] = []
  let low = 0
  let high = Number.MAX_SAFE_INTEGER
  while (low < cut) {
    if (high <= cut) {
      blocks.push([low, high])
      break
    }
    if (high - low <= 1) {
      break
    }
    const mid = low + Math.floor((high - low) / 2)
    if (cut <= mid) {
      high = mid
    } else {
      blocks.push([low, mid])
      low = mid
    }
  }
  return blocks
}
