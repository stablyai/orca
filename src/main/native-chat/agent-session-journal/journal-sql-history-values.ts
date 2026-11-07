import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemSubagentId } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { offPageSubagentRoster } from '../agent-session-wire/publication/history/agent-session-history-subagent-roster'
import { namedSubagents } from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlReadValues } from './journal-sql-read-values'
import { parseJournalSqlValue } from './journal-sql-value-codec'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'
import type { JournalSqlHistoryWork } from './journal-sql-history-page'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** A page owns the decoded bodies and their transitive references only for its read transaction. */
export class JournalSqlHistoryValues {
  private readonly values: JournalSqlReadValues
  private readonly loaded = new Map<string, AgentJournalRenderItem>()
  readonly submissions = new Map<string, AgentJournalSubmission>()
  readonly submissionOrder = new Map<string, number>()
  constructor(
    private readonly db: Database.Database,
    private readonly scope: JournalSqlScope,
    work: JournalSqlHistoryWork
  ) {
    this.values = new JournalSqlReadValues(scope, (location) => {
      if (location.collection === 'items') {
        work.bodies++
      }
    })
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
      WHERE session_id=? AND epoch=? AND entry_key=?`)
      .get(...this.scope.prefix, key)
    return row ? this.item(row) : undefined
  }

  loadSubmissions(keys: string[]): void {
    const rows = this.db
      .prepare(`SELECT s.client_message_id, s.incarnation, s.payload_json, s.input_ordinal
      FROM json_each(?) wanted CROSS JOIN journal_proj_submissions s INDEXED BY journal_proj_submissions_item
      WHERE s.session_id=? AND s.epoch=? AND s.current=1 AND s.item_key=wanted.value
      ORDER BY s.submitted_at, s.input_ordinal`)
      .all(JSON.stringify(keys), ...this.scope.prefix)
    for (const row of rows) {
      const key = JSON.stringify(row.client_message_id)
      if (!this.submissions.has(key)) {
        this.submissionOrder.set(key, Number(row.input_ordinal))
        this.submissions.set(
          key,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the submissions collection owns these typed values.
          this.values.load(
            { collection: 'submissions', key, incarnation: Number(row.incarnation), path: [] },
            parseJournalSqlValue(row.payload_json, [], (json) => this.scope.parse(json))
          ) as AgentJournalSubmission
        )
      }
    }
  }

  snapshot(cursor: AgentJournalCursor, ids: ReadonlySet<string>): AgentJournalSnapshot {
    const keys = [...ids].map((id) => JSON.stringify(id))
    const rows = this.db
      .prepare(`SELECT item.entry_key, item.incarnation FROM json_each(?) wanted
      CROSS JOIN journal_proj_items item
      WHERE item.session_id=? AND item.epoch=? AND item.entry_key=wanted.value AND item.hidden=0
      ORDER BY item.sequence, item.sequence_index, item.ordinal`)
      .all(JSON.stringify(keys), ...this.scope.prefix)
    this.loadSubmissions(keys)
    return {
      sessionId: this.scope.sessionId,
      cursor,
      items: rows.map((row) => this.item(row)),
      submissions: [...this.submissions.values()]
        .filter((submission) => ids.has(agentJournalSubmissionKey(submission.clientMessageId)))
        .sort(
          (a, b) =>
            a.submittedAt - b.submittedAt ||
            this.submissionOrder.get(JSON.stringify(a.clientMessageId))! -
              this.submissionOrder.get(JSON.stringify(b.clientMessageId))!
        )
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
