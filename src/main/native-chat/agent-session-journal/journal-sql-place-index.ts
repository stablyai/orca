import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import {
  mergeInputPlaces,
  type InputPlaceQuery,
  type JournalInputPlaceEntry
} from './input-order/journal-input-place-index'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlScope } from './journal-sql-scope'

export function journalSqlPlaceSummary(scope: JournalSqlScope, row: SqliteRow): InputPlaceQuery {
  const card = row.card_json === null ? undefined : scope.decode<QueuedMessageRow>(row.card_json)
  return {
    position: Number(row.position),
    ...(row.head ? { head: card } : {}),
    ...(row.command ? { command: card } : {}),
    ...(row.waiting ? { waiting: card } : {}),
    ...(row.handoff ? { handoff: card } : {})
  }
}

export function compareJournalSqlPlaces(a: SqliteRow, b: SqliteRow): number {
  return (
    Number(a.sequence) - Number(b.sequence) ||
    Number(a.tie ?? 0) - Number(b.tie ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  )
}

export function journalSqlCardFlags(
  card: QueuedMessageRow,
  actionable: boolean,
  handoff: boolean
): [number, number, number, number] {
  const head = (card.state === 'waiting' && card.holdReason === null) || card.state === 'returned'
  return [
    Number(head),
    Number(actionable && !!card.body.command),
    Number(actionable),
    Number(handoff)
  ]
}

export function journalSqlEntryFlags(entry: InputPlaceQuery): [number, number, number, number] {
  return [
    Number(!!entry.head),
    Number(!!entry.command),
    Number(!!entry.waiting),
    Number(!!entry.handoff)
  ]
}

export function journalSqlEntryCard(entry: InputPlaceQuery): QueuedMessageRow | undefined {
  return entry.head ?? entry.waiting ?? entry.handoff ?? entry.command
}

/** Admission summaries fetch live flags and seek positions separately from card bodies. */
export class JournalSqlPlaceIndex implements JournalInputPlaceStorage {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {}

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  set(
    card: QueuedMessageRow,
    actionable: boolean,
    handoff: boolean,
    coordinate: AgentJournalCursor | null = card.queuedAt
  ): void {
    if (card.state === 'withdrawn') {
      this.delete(card.messageId)
      return
    }
    const flags = journalSqlCardFlags(card, actionable, handoff)
    if (!flags.some(Boolean)) {
      this.scope.forget(`places:${this.indexId}`, card.messageId)
    }
    this.scope.db
      .prepare(`INSERT OR REPLACE INTO journal_proj_places
        (session_id, epoch, index_id, id, domain, sequence, tie, position,
         head, command, waiting, handoff, card_json) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.prefix,
        card.messageId,
        coordinate?.epoch ?? '',
        coordinate?.sequence ?? 0,
        card.position,
        ...flags,
        flags.some(Boolean)
          ? this.scope.encode(card, `places:${this.indexId}`, card.messageId)
          : null
      )
  }

  /** An actual open's export writes each restored entry as the memory index holds it. */
  importEntry(entry: JournalInputPlaceEntry): void {
    const card = journalSqlEntryCard(entry)
    this.scope.db
      .prepare(`INSERT INTO journal_proj_places
        (session_id, epoch, index_id, id, domain, sequence, tie, position,
         head, command, waiting, handoff, card_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.prefix,
        entry.id,
        entry.domain ?? null,
        entry.sequence,
        entry.tie ?? 0,
        entry.position,
        ...journalSqlEntryFlags(entry),
        card ? this.scope.encode(card, `places:${this.indexId}`, entry.id) : null
      )
  }

  setPosition(id: string, position: number, tie = 0, coordinate?: AgentJournalCursor): void {
    // Matching numeric entries keep their flags, as the memory implementation's no-op does.
    const result = this.scope.db
      .prepare(`INSERT INTO journal_proj_places
        (session_id, epoch, index_id, id, domain, sequence, tie, position,
         head, command, waiting, handoff, card_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL)
        ON CONFLICT(session_id, epoch, index_id, id) DO UPDATE SET
          domain=excluded.domain, sequence=excluded.sequence, tie=excluded.tie,
          position=excluded.position, head=0, command=0, waiting=0, handoff=0, card_json=NULL
        WHERE domain IS NOT excluded.domain OR sequence<>excluded.sequence
          OR tie<>excluded.tie OR position<>excluded.position`)
      .run(
        ...this.prefix,
        id,
        coordinate?.epoch ?? null,
        coordinate?.sequence ?? position,
        tie,
        position
      )
    if (result.changes) {
      this.scope.forget(`places:${this.indexId}`, id)
    }
  }

  delete(id: string): void {
    this.scope.forget(`places:${this.indexId}`, id)
    this.scope.db
      .prepare(`DELETE FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND id=?`)
      .run(...this.prefix, id)
  }

  clear(): void {
    this.scope.forget(`places:${this.indexId}`)
    this.scope.db
      .prepare('DELETE FROM journal_proj_places WHERE session_id=? AND epoch=? AND index_id=?')
      .run(...this.prefix)
  }

  isEmpty(): boolean {
    const row = this.scope.db
      .prepare(`SELECT id FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? LIMIT 1`)
      .get(...this.prefix)
    if (row) {
      this.scope.examined(row)
    }
    return !row
  }

  query(epoch: string, sequence = Infinity): InputPlaceQuery {
    return this.summary({ epoch, sequence })
  }

  allPlaces(): InputPlaceQuery {
    return this.summary()
  }

  queryCommand(epoch: string, sequence: number): QueuedMessageRow | undefined {
    return this.summary({ epoch, sequence }, true).command
  }

  allCommand(): QueuedMessageRow | undefined {
    return this.summary(undefined, true).command
  }

  private summary(cut?: { epoch: string; sequence: number }, commandOnly = false): InputPlaceQuery {
    const flags = commandOnly ? 'command' : '(head OR command OR waiting OR handoff)'
    const rows = this.scope.db
      .prepare(`SELECT id, sequence, tie, position, head, command, waiting, handoff, card_json
        FROM journal_proj_places WHERE session_id=? AND epoch=? AND index_id=?
        AND ${flags} ${cut ? 'AND domain=? AND sequence<?' : ''}`)
      .all(...this.prefix, ...(cut ? [cut.epoch, cut.sequence] : []))
    rows.forEach((row) => this.scope.examined(row))
    rows.sort(compareJournalSqlPlaces)
    let result: InputPlaceQuery = { position: -Infinity }
    for (const row of rows) {
      result = mergeInputPlaces(result, journalSqlPlaceSummary(this.scope, row))
    }
    if (!commandOnly) {
      const eligible = this.scope.db
        .prepare(`SELECT MAX(position) AS position FROM journal_proj_places
          WHERE session_id=? AND epoch=? AND index_id=? ${cut ? 'AND domain=? AND sequence<?' : ''}`)
        .get(...this.prefix, ...(cut ? [cut.epoch, cut.sequence] : []))!
      this.scope.examined(eligible)
      if (eligible.position !== null) {
        result.position = Number(eligible.position)
      }
    }
    return result
  }

  lastId(): string | undefined {
    const rows = this.edge(true)
    return rows.at(-1)?.id?.toString()
  }

  successorId(sequence: number): string | undefined {
    return this.edge(false, sequence).at(0)?.id?.toString()
  }

  firstPosition(): number {
    return Number(this.edge(false).at(0)?.position ?? Infinity)
  }

  private edge(descending: boolean, after?: number): SqliteRow[] {
    const row = this.scope.db
      .prepare(`SELECT sequence, tie FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? ${after === undefined ? '' : 'AND sequence>?'}
        ORDER BY sequence ${descending ? 'DESC' : 'ASC'}, tie ${descending ? 'DESC' : 'ASC'} LIMIT 1`)
      .get(...this.prefix, ...(after === undefined ? [] : [after]))
    if (!row) {
      return []
    }
    this.scope.examined(row)
    const ties = this.scope.db
      .prepare(`SELECT id, sequence, tie, position FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND sequence=? AND tie=?`)
      .all(...this.prefix, row.sequence, row.tie)
    ties.forEach((tie) => this.scope.examined(tie))
    return ties.sort(compareJournalSqlPlaces)
  }

  idsAfter(sequence: number): string[] {
    const rows = this.scope.db
      .prepare(`SELECT id, sequence, tie FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND sequence>? ORDER BY sequence, tie`)
      .all(...this.prefix, sequence)
    rows.forEach((row) => this.scope.examined(row))
    return rows.sort(compareJournalSqlPlaces).map((row) => String(row.id))
  }
}
