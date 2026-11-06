import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { decodeJournalOutcomeItem } from './journal-outcome-codec'
import type { JournalSqlScope } from './journal-sql-scope'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type {
  JournalSqlValueLocation,
  JournalSqlValueReference,
  StoredJournalSqlValue
} from './journal-sql-value-codec'

/** Item incarnations keep original log pointers; only values without a saved outcome stay inline. */
export class JournalSqlItemValues {
  private readonly pending = new Map<string, JournalSqlValueLocation>()
  private readonly detached = new Map<string, SqliteRow>()

  constructor(private readonly scope: JournalSqlScope) {}

  store(
    location: JournalSqlValueLocation,
    encoded: string,
    value: unknown,
    current: boolean,
    ordinal: number,
    preserve = false
  ): string {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the typed items collection uses this payload home.
    const item = value as AgentJournalRenderItem
    const { refs }: { refs: JournalSqlValueReference[] } = JSON.parse(encoded)
    const key = JSON.stringify([location.key, location.incarnation])
    const original = preserve ? this.detached.get(key) : undefined
    this.scope.db
      .prepare(`INSERT INTO journal_proj_item_versions
      (session_id, generation, entry_key, incarnation, inline_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, generation, entry_key, incarnation) DO UPDATE SET
        outcome_generation=NULL, outcome_seq=NULL, inline_json=excluded.inline_json`)
      .run(...this.scope.prefix, location.key, location.incarnation, encoded)
    this.pending.set(JSON.stringify([location.key, location.incarnation]), location)
    if (original?.outcome_generation !== undefined && original.outcome_generation !== null) {
      this.scope.db
        .prepare(`UPDATE journal_proj_item_versions
        SET outcome_generation=?, outcome_seq=?, inline_json=NULL
        WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
        .run(
          original.outcome_generation,
          original.outcome_seq,
          ...this.scope.prefix,
          location.key,
          location.incarnation
        )
      this.pending.delete(key)
    }
    if (current) {
      this.metadata(location, item, Buffer.byteLength(encoded), ordinal)
    }
    return JSON.stringify({ refs })
  }

  load(location: JournalSqlValueLocation, token: unknown): StoredJournalSqlValue {
    const version = this.scope.db
      .prepare(`SELECT outcome_generation, outcome_seq, inline_json FROM journal_proj_item_versions
      WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
      .get(...this.scope.prefix, location.key, location.incarnation)
    if (!version) {
      throw new Error('Missing journal item incarnation')
    }
    this.scope.examined(version)
    if (typeof version.inline_json === 'string') {
      return this.scope.decode(version.inline_json)
    }
    const row = this.scope.db
      .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes WHERE generation=? AND seq=? AND field='items' AND entry_key=?`)
      .get(version.outcome_generation, version.outcome_seq, location.key)
    if (!row) {
      throw new Error('Missing journal item outcome')
    }
    this.scope.examined(row)
    this.scope.work.decodedBytes += Buffer.byteLength(String(row.value_json))
    const item = decodeJournalOutcomeItem(row)
    const { refs } = this.scope.decode<{ refs: JournalSqlValueReference[] }>(token)
    return { data: [item], refs }
  }

  /** Called after each applied row's outcomes are inserted, within the same command SAVEPOINT. */
  bind(outcomeGeneration: number, through: number): void {
    const newest = this.scope.db.prepare(`SELECT seq, deleted FROM journal_outcomes
      WHERE generation=? AND field='items' AND entry_key=? AND seq<=?
      ORDER BY seq DESC LIMIT 1`)
    const bind = this.scope.db.prepare(`UPDATE journal_proj_item_versions SET
      outcome_generation=?, outcome_seq=?, inline_json=NULL
      WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
    for (const location of this.pending.values()) {
      const row = newest.get(outcomeGeneration, location.key, through)
      if (row) {
        this.scope.examined(row)
      }
      // Only this row's final incarnation has an outcome; intermediate captures keep their value.
      const current = this.scope.db
        .prepare(`SELECT incarnation FROM journal_proj_items
        WHERE session_id=? AND generation=? AND entry_key=?`)
        .get(...this.scope.prefix, location.key)
      if (current) {
        this.scope.examined(current)
      }
      if (
        row?.seq === through &&
        row.deleted === 0 &&
        current?.incarnation === location.incarnation
      ) {
        bind.run(
          outcomeGeneration,
          row.seq,
          ...this.scope.prefix,
          location.key,
          location.incarnation
        )
        this.scope.db
          .prepare(`UPDATE journal_proj_items SET byte_size=(SELECT length(CAST(value_json AS BLOB))
          FROM journal_outcomes WHERE generation=? AND seq=? AND field='items' AND entry_key=?)
          WHERE session_id=? AND generation=? AND entry_key=?`)
          .run(outcomeGeneration, row.seq, location.key, ...this.scope.prefix, location.key)
      }
    }
    this.pending.clear()
  }

  delete(key: string): void {
    this.scope.db
      .prepare('DELETE FROM journal_proj_items WHERE session_id=? AND generation=? AND entry_key=?')
      .run(...this.scope.prefix, key)
  }

  forget(location: JournalSqlValueLocation): void {
    const row = this.scope.db
      .prepare(`SELECT outcome_generation, outcome_seq FROM journal_proj_item_versions
      WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
      .get(...this.scope.prefix, location.key, location.incarnation)
    if (row) {
      this.scope.examined(row)
      this.detached.set(JSON.stringify([location.key, location.incarnation]), row)
    }
    this.scope.db
      .prepare(`DELETE FROM journal_proj_item_versions
      WHERE session_id=? AND generation=? AND entry_key=? AND incarnation=?`)
      .run(...this.scope.prefix, location.key, location.incarnation)
    this.pending.delete(JSON.stringify([location.key, location.incarnation]))
  }

  private metadata(
    location: JournalSqlValueLocation,
    item: AgentJournalRenderItem,
    bytes: number,
    ordinal: number
  ): void {
    const turn = readAgentJournalTurn(item.body)
    this.scope.db
      .prepare(`INSERT INTO journal_proj_items
      (session_id, generation, entry_key, incarnation, ordinal, sequence, sequence_index,
       revision, kind, turn_id, turn_item_id, opener_item_id, root, subagent_id, context_clear, byte_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, generation, entry_key) DO UPDATE SET
      incarnation=excluded.incarnation, ordinal=excluded.ordinal, sequence=excluded.sequence,
      sequence_index=excluded.sequence_index, revision=excluded.revision, kind=excluded.kind,
      turn_id=excluded.turn_id, turn_item_id=excluded.turn_item_id,
      opener_item_id=excluded.opener_item_id, root=excluded.root,
      subagent_id=excluded.subagent_id, context_clear=excluded.context_clear, byte_size=excluded.byte_size`)
      .run(
        ...this.scope.prefix,
        location.key,
        location.incarnation,
        ordinal,
        item.sequence,
        item.sequenceIndex ?? 0,
        item.revision,
        item.body.kind,
        turn?.turnId ?? null,
        item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null,
        turn?.userItemId ?? null,
        Number(isRootAgentJournalItem(item)),
        item.agentId ?? null,
        Number(isAgentSessionContextClear(item.body)),
        bytes
      )
  }
}
