import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestStructuredAgentSessionTurn } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import {
  boundHistoryItemsByBytes,
  historyContentBytes,
  resolveHistoryLimit,
  submissionBytesByItemId,
  type HistoryReader
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { CLIENT_HISTORY_READER } from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlScalars } from './journal-sql-scalars'
import { JournalSqlHistoryValues } from './journal-sql-history-values'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { readJournalSqlForwardHistory } from './journal-sql-history-after'

export type JournalSqlHistoryRequest = Omit<AgentSessionHistoryRequest, 'direction'> & {
  direction: AgentSessionHistoryRequest['direction'] | 'hydrate'
  fence?: number
  scope?: 'every-agent' | 'own-agent'
  rowReplay?: boolean
}

export type JournalSqlHistoryWork = { bodies: number }

/** The caller owns the connection; one page, its coverage check and reset share one WAL snapshot. */
export function readJournalSqlHistoryPage(
  db: Database.Database,
  request: JournalSqlHistoryRequest,
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'> = CLIENT_HISTORY_READER,
  work: JournalSqlHistoryWork = { bodies: 0 }
): AgentSessionHistoryResult {
  return readJournalSqlProjection(db, request.sessionId, (scope) =>
    new HistoryPage(db, request.sessionId, scope.epoch, reader, work).read(request)
  )
}

class HistoryPage {
  private readonly scope: JournalSqlScope
  private readonly values: JournalSqlHistoryValues
  private readonly epoch: string
  private readonly sequence: number

  constructor(
    private readonly db: Database.Database,
    sessionId: string,
    epoch: string,
    private readonly reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
    private readonly work: JournalSqlHistoryWork
  ) {
    this.scope = new JournalSqlScope(db, sessionId, epoch)
    this.values = new JournalSqlHistoryValues(db, this.scope, work)
    const scalars = new JournalSqlScalars(this.scope, 'reducer')
    const meta = db.prepare('SELECT epoch FROM journal_proj_meta WHERE session_id=?').get(sessionId)
    this.epoch = journalContextEpoch(String(meta!.epoch), scalars.get('contextBoundary', 1))
    this.sequence = scalars.get('lastSequence', 0)
  }

  read(request: JournalSqlHistoryRequest): AgentSessionHistoryResult {
    if (request.direction === 'after') {
      return readJournalSqlForwardHistory(
        this.scope,
        request,
        this.reader,
        this.work,
        this.latestTurnItem(),
        (reset) => ({
          ok: false,
          reset,
          page: this.page({
            ...request,
            direction: 'hydrate',
            fence: undefined,
            scope: 'every-agent'
          })
        })
      )
    }
    const cursor = request.direction === 'before' ? request.cursor : undefined
    if (cursor && (cursor.epoch !== this.epoch || cursor.sequence > this.sequence)) {
      return {
        ok: false,
        reset: cursor.epoch !== this.epoch ? 'epoch_changed' : 'cursor_ahead',
        page: this.page({
          ...request,
          direction: 'hydrate',
          fence: undefined,
          scope: 'every-agent'
        })
      }
    }
    return { ok: true, page: this.page(request) }
  }

  private page(request: JournalSqlHistoryRequest): AgentSessionHistoryPage {
    const cursor = request.direction === 'before' ? request.cursor : undefined
    const end = cursor?.sequence ?? Number.MAX_SAFE_INTEGER
    const own = request.scope === 'own-agent' ? ' AND root=1' : ''
    const where = `session_id=? AND epoch=? AND hidden=0${own}`
    const prefix = this.scope.prefix
    const limit = request.direction === 'hydrate' ? 200 : resolveHistoryLimit(request.limit)
    const start = this.windowStart(where, end, limit)
    const headers = this.db
      .prepare(`SELECT entry_key, incarnation, sequence FROM journal_proj_items WHERE ${where}
        AND sequence>=? AND sequence<? ORDER BY sequence DESC, sequence_index DESC, ordinal DESC`)
      .all(...prefix, start, end)
    this.values.loadSubmissions(headers.map((row) => String(row.entry_key)))
    const sizes = submissionBytesByItemId([...this.values.submissions.values()])
    let kept: AgentJournalRenderItem[] = []
    let total = 0
    for (const rows of sequenceGroups(headers)) {
      const items = rows.map((row) => this.values.item(row))
      const formed = items.map(this.reader.form)
      const bytes = historyContentBytes(formed, [], sizes)
      if (kept.length > 0 && total + bytes > this.reader.budgetBytes) {
        break
      }
      const bounded = boundHistoryItemsByBytes(
        items,
        'newest',
        sizes,
        this.reader.budgetBytes,
        this.reader.form
      )
      kept = [...bounded.items, ...kept]
      total += bytes
      if (bytes > this.reader.budgetBytes) {
        break
      }
    }
    const oldest = kept[0]
    const newest = kept.at(-1)
    const hasOlder = !!this.db
      .prepare(`SELECT 1 FROM journal_proj_items WHERE ${where}
      AND sequence<? AND sequence<? LIMIT 1`)
      .get(...prefix, oldest?.sequence ?? end, end)
    const hasNewer = !!this.db
      .prepare(`SELECT 1 FROM journal_proj_items WHERE ${where}
      AND sequence>=? LIMIT 1`)
      .get(...prefix, end)
    const turn = this.latestTurnItem()
    const roster = this.values.roster(where, kept)
    const epoch = this.epoch
    const pageIds = new Set(kept.map((item) => item.itemId))
    return {
      sessionId: request.sessionId,
      epoch,
      ...(request.fence === undefined ? {} : { fence: request.fence }),
      direction: request.direction === 'hydrate' ? 'tail' : request.direction,
      items: kept,
      removedItemIds: [],
      submissions: [...this.values.submissions.values()]
        .filter((submission) => pageIds.has(agentJournalSubmissionKey(submission.clientMessageId)))
        .sort(
          (a, b) =>
            a.submittedAt - b.submittedAt ||
            this.values.submissionOrder.get(JSON.stringify(a.clientMessageId))! -
              this.values.submissionOrder.get(JSON.stringify(b.clientMessageId))!
        ),
      window: {
        oldest: oldest ? { epoch, sequence: oldest.sequence } : null,
        newest: newest ? { epoch, sequence: newest.sequence } : null,
        nextCursor: oldest
          ? { epoch, sequence: oldest.sequence }
          : (cursor ?? { epoch, sequence: 0 })
      },
      liveCursor: { epoch, sequence: this.sequence },
      hasOlder,
      hasNewer,
      ...(roster === undefined ? {} : { subagentRoster: roster }),
      latestTurn: latestStructuredAgentSessionTurn(turn ? [turn] : [])
    }
  }

  private latestTurnItem(): AgentJournalRenderItem | null {
    const turn = this.db
      .prepare(`SELECT entry_key, incarnation FROM journal_proj_items INDEXED BY journal_proj_items_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND (turn_id IS NOT NULL OR context_clear=1)
      AND sequence=(SELECT sequence FROM journal_proj_items INDEXED BY journal_proj_items_turn
        WHERE session_id=? AND epoch=? AND hidden=0 AND (turn_id IS NOT NULL OR context_clear=1)
        ORDER BY sequence DESC, ordinal DESC LIMIT 1)
      ORDER BY sequence_index DESC, ordinal DESC LIMIT 1`)
      .get(...this.scope.prefix, ...this.scope.prefix)
    return turn ? this.values.item(turn) : null
  }

  private windowStart(where: string, end: number, limit: number): number {
    const groups = this.db
      .prepare(`SELECT sequence, COUNT(*) AS count FROM journal_proj_items
      WHERE ${where} AND sequence<? AND root=1 AND subagent_row=0
      GROUP BY sequence ORDER BY sequence DESC LIMIT ?`)
      .all(...this.scope.prefix, end, 2 * limit + 1)
    const boundary = (cap: number) => {
      let count = 0
      let start = 0
      for (const group of groups) {
        const size = Number(group.count)
        if (count > 0 && count + size > cap) {
          return start
        }
        count += size
        start = Number(group.sequence)
      }
      return 0
    }
    let start = boundary(limit)
    const floor = boundary(2 * limit)
    while (start > floor) {
      const row = this.db
        .prepare(`SELECT MIN(sequence) AS first FROM journal_proj_items
        WHERE ${where} AND sequence<? AND subagent_group_key IN (
          SELECT subagent_group_key FROM journal_proj_items WHERE ${where}
          AND sequence>=? AND sequence<? AND subagent_group_key IS NOT NULL)`)
        .get(...this.scope.prefix, end, ...this.scope.prefix, start, end)
      const first = row?.first === null || row?.first === undefined ? start : Number(row.first)
      const next = Math.max(floor, Math.min(start, first))
      if (next === start) {
        break
      }
      start = next
    }
    return start
  }
}

function* sequenceGroups(rows: Iterable<SqliteRow>): Generator<SqliteRow[]> {
  let group: SqliteRow[] = []
  for (const row of rows) {
    if (group.length > 0 && row.sequence !== group[0]!.sequence) {
      yield group.toReversed()
      group = []
    }
    group.push(row)
  }
  if (group.length > 0) {
    yield group.toReversed()
  }
}
