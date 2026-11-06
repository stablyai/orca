import type { JournalTurnSourceStorage } from './journal-index-storage'
import { compareTurnSources, type TurnSource } from './journal-newest-turn-tree'
import type { JournalSqlScope } from './journal-sql-scope'

export class JournalSqlTurnSources implements JournalTurnSourceStorage {
  constructor(private readonly scope: JournalSqlScope) {}

  get(id: string): TurnSource | undefined {
    const row = this.scope.db
      .prepare(`SELECT source_json FROM journal_proj_turn_sources
        WHERE session_id=? AND epoch=? AND id=?`)
      .get(...this.scope.prefix, id)
    if (!row) {
      return undefined
    }
    this.scope.examined(row)
    return this.scope.decode<TurnSource>(row.source_json)
  }

  set(id: string, source: TurnSource): void {
    this.scope.db
      .prepare(`INSERT OR REPLACE INTO journal_proj_turn_sources
        (session_id, epoch, id, sequence, sequence_index, ordinary, relevant, source_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.scope.prefix,
        id,
        source.item.sequence,
        source.item.sequenceIndex ?? 0,
        Number(source.ordinary),
        Number(source.relevant),
        this.scope.encode(source, 'turn-sources', id)
      )
  }

  delete(id: string): void {
    this.scope.forget('turn-sources', id)
    this.scope.db
      .prepare('DELETE FROM journal_proj_turn_sources WHERE session_id=? AND epoch=? AND id=?')
      .run(...this.scope.prefix, id)
  }

  latest(): TurnSource | undefined {
    return this.newest('')
  }

  anchor(): TurnSource | undefined {
    return this.newest('AND ordinary')
  }

  winner(): TurnSource | undefined {
    return this.newest('AND relevant')
  }

  private newest(predicate: '' | 'AND ordinary' | 'AND relevant'): TurnSource | undefined {
    const edge = this.scope.db
      .prepare(`SELECT sequence, sequence_index FROM journal_proj_turn_sources
        WHERE session_id=? AND epoch=? ${predicate}
        ORDER BY sequence DESC, sequence_index DESC LIMIT 1`)
      .get(...this.scope.prefix)
    if (!edge) {
      return undefined
    }
    this.scope.examined(edge)
    const ties = this.scope.db
      .prepare(`SELECT source_json FROM journal_proj_turn_sources
        WHERE session_id=? AND epoch=? ${predicate} AND sequence=? AND sequence_index=?`)
      .all(...this.scope.prefix, edge.sequence, edge.sequence_index)
    const sources = ties.map((row) => {
      this.scope.examined(row)
      return this.scope.decode<TurnSource>(row.source_json)
    })
    return sources.sort(compareTurnSources).at(-1)
  }
}
