import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemSubagentId } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { offPageSubagentRoster } from '../agent-session-wire/agent-session-history-subagent-roster'
import { namedSubagents } from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlItemValues } from './journal-sql-item-values'
import { JournalSqlValueReader } from './journal-sql-value-reader'
import { JournalSqlValueObjects } from './journal-sql-value-objects'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'
import { projectJournalStopNote } from './journal-stop-note-projection'
import type { JournalSqlHistoryWork } from './journal-sql-history-page'

// A reader never edits loaded values; keeping them plain also permits worker structured cloning.
class ReadObjects extends JournalSqlValueObjects {
  constructor(private readonly work: JournalSqlHistoryWork) {
    super(() => {})
  }
  override track(value: unknown, location: JournalSqlValueLocation): unknown {
    if (location.collection === 'items') {
      this.work.bodies++
    }
    return value
  }
}

/** A page owns the decoded bodies and their transitive references only for its read transaction. */
export class JournalSqlHistoryValues {
  private readonly values: JournalSqlValueReader
  private readonly loaded = new Map<string, AgentJournalRenderItem>()
  readonly submissions = new Map<string, AgentJournalSubmission>()
  readonly submissionOrder = new Map<string, number>()
  constructor(
    private readonly db: Database.Database,
    private readonly scope: JournalSqlScope,
    work: JournalSqlHistoryWork
  ) {
    this.values = new JournalSqlValueReader(
      scope,
      new ReadObjects(work),
      new JournalSqlItemValues(scope)
    )
  }
  item(row: SqliteRow): AgentJournalRenderItem {
    const key = String(row.entry_key)
    let item = this.loaded.get(key)
    if (!item) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only render items are stored in this typed collection.
      item = this.values.load({
        collection: 'items',
        key,
        incarnation: Number(row.incarnation),
        path: []
      }) as AgentJournalRenderItem
      this.loaded.set(key, item)
      item = projectJournalStopNote(item, {
        get: (id) => this.itemById(id),
        has: (id) => this.itemById(id) !== undefined
      })
      this.loaded.set(key, item)
    }
    return item
  }

  private itemById(id: string): AgentJournalRenderItem | undefined {
    const key = JSON.stringify(id)
    const loaded = this.loaded.get(key)
    if (loaded) {
      return loaded
    }
    const row = this.db
      .prepare(`SELECT entry_key, incarnation FROM journal_proj_items
      WHERE session_id=? AND generation=? AND entry_key=?`)
      .get(...this.scope.prefix, key)
    return row ? this.item(row) : undefined
  }

  loadSubmissions(keys: string[]): void {
    const rows = this.db
      .prepare(`SELECT v.entry_key, v.incarnation, v.value_json, s.input_ordinal
      FROM json_each(?) wanted CROSS JOIN journal_proj_submissions s INDEXED BY journal_proj_submissions_item
      CROSS JOIN journal_proj_values v
      WHERE s.session_id=? AND s.generation=? AND s.item_key=wanted.value
      AND v.session_id=s.session_id AND v.generation=s.generation
      AND v.collection='submissions' AND v.entry_key=s.entry_key
      ORDER BY s.submitted_at, s.input_ordinal`)
      .all(JSON.stringify(keys), ...this.scope.prefix)
    for (const row of rows) {
      const key = String(row.entry_key)
      if (!this.submissions.has(key)) {
        this.submissionOrder.set(key, Number(row.input_ordinal))
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the submissions collection owns these typed values.
        this.submissions.set(
          key,
          this.values.load(
            { collection: 'submissions', key, incarnation: Number(row.incarnation), path: [] },
            row.value_json
          ) as AgentJournalSubmission
        )
      }
    }
  }

  roster(where: string, page: AgentJournalRenderItem[]) {
    const missing = new Set(page.map(agentJournalItemSubagentId).filter((id) => id !== null))
    for (const item of page) {
      if (item.agentId === undefined && item.body.kind === 'message') {
        for (const name of item.body.blocks.flatMap(namedSubagents)) {
          missing.delete(name.id)
        }
      }
    }
    const ids = [...missing]
    if (ids.length === 0) {
      return undefined
    }
    const rows = this.db
      .prepare(`SELECT entry_key, incarnation, subagent_names FROM journal_proj_items
      WHERE ${where} AND root=1 AND subagent_names IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(subagent_names) WHERE json_extract(value, '$.id')
        IN (SELECT value FROM json_each(?))) ORDER BY sequence, sequence_index, ordinal`)
      .iterate(...this.scope.prefix, JSON.stringify(ids))
    const named: AgentJournalRenderItem[] = []
    for (const row of rows) {
      const names: { id: string }[] = JSON.parse(String(row.subagent_names))
      if (!names.some((name) => missing.has(name.id))) {
        continue
      }
      for (const name of names) {
        missing.delete(name.id)
      }
      named.push(this.item(row))
      const roster = offPageSubagentRoster(named, page)
      if (
        missing.size === 0 ||
        (roster?.length ?? 0) >= 64 ||
        Buffer.byteLength(JSON.stringify(roster)) >= 16 * 1024
      ) {
        return roster
      }
    }
    return offPageSubagentRoster(named, page)
  }
}
