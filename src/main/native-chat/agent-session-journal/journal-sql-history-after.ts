import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import { isStructuredAgentSessionStopNote } from '../agent-session-wire/operations/structured-agent-session-command-turn'
import { readAgentSessionForwardHistory } from '../agent-session-wire/publication/history/agent-session-history-forward-page'
import {
  resolveHistoryLimit,
  type HistoryReader
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlHistoryRequest, JournalSqlHistoryWork } from './journal-sql-history-page'
import { JournalSqlHistoryValues } from './journal-sql-history-values'
import { JournalSqlReadValues } from './journal-sql-read-values'
import { JournalSqlScalars } from './journal-sql-scalars'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { readJournalSince } from './replay/journal-cursor'
import { readJournalRowsAfterCursor } from './replay/journal-read-row'

/** Replay one row window, then load only its current item keys in the same reader snapshot. */
export function readJournalSqlForwardHistory(
  scope: JournalSqlScope,
  request: JournalSqlHistoryRequest,
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
  work: JournalSqlHistoryWork,
  latestTurn: AgentJournalRenderItem | null,
  reset: (
    reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ) => AgentSessionHistoryResult
): AgentSessionHistoryResult {
  const scalars = new JournalSqlScalars(scope, 'reducer')
  const cursor = {
    epoch: journalContextEpoch(scope.epoch, scalars.get('contextBoundary', 1)),
    sequence: scalars.get('lastSequence', 0)
  }
  const snapshot = {
    sessionId: scope.sessionId,
    cursor,
    items: latestTurn ? [latestTurn] : [],
    submissions: []
  }
  if (
    !request.rowReplay &&
    request.cursor?.epoch === cursor.epoch &&
    request.cursor.sequence <= cursor.sequence &&
    hasNormalizedHandOff(scope)
  ) {
    return reset('cursor_compacted')
  }
  const values = new JournalSqlReadValues(scope, () => {})
  const history = new JournalSqlHistoryValues(scope.db, scope, work)
  return readAgentSessionForwardHistory(
    {
      readSince: (after, limit) =>
        readJournalSince(
          {
            state: {
              epoch: cursor.epoch,
              lastSequence: cursor.sequence,
              oldestSequence: scalars.get('oldestSequence', 1)
            },
            rowsAfter: (sequence) => {
              const read = readJournalRowsAfterCursor(
                scope.db,
                scope.sessionId,
                scope.epoch,
                sequence,
                limit
              )
              return {
                ...read,
                rows: read.rows.map((row) => ({ ...row, epoch: cursor.epoch }))
              }
            }
          },
          after,
          () => cursor
        ),
      canonicalItemId: (id) => values.get<string>('aliases', id) ?? id,
      hasSubmission: (id) => values.has('submissions', id),
      stopNoteIds: (ids) => stopNotes(scope, ids),
      reset
    },
    snapshot,
    request.cursor,
    resolveHistoryLimit(request.limit),
    reader,
    (ids) => history.snapshot(cursor, ids)
  )
}

function hasNormalizedHandOff(scope: JournalSqlScope): boolean {
  return !!scope.db
    .prepare(`SELECT 1 FROM journal_proj_normalized_handoffs normalized
    CROSS JOIN journal_proj_submissions submission
    CROSS JOIN journal_proj_items item
    WHERE normalized.session_id=? AND normalized.epoch=?
      AND submission.session_id=normalized.session_id AND submission.epoch=normalized.epoch
      AND submission.client_message_id=normalized.input_id AND submission.current=1
      AND item.session_id=submission.session_id AND item.epoch=submission.epoch
      AND item.entry_key=submission.item_key AND item.hidden=0 LIMIT 1`)
    .get(...scope.prefix)
}

function stopNotes(scope: JournalSqlScope, turnItemIds: ReadonlySet<string>): string[] {
  return scope.db
    .prepare(`SELECT item.entry_key FROM json_each(?) wanted
    CROSS JOIN journal_proj_items item INDEXED BY journal_proj_items_turn_scope
    WHERE item.session_id=? AND item.epoch=? AND item.turn_item_id=wanted.value
      AND item.turn_item_id IS NOT NULL AND item.kind='status' AND item.hidden=0`)
    .all(JSON.stringify([...turnItemIds]), ...scope.prefix)
    .map((row) => scope.decode<string>(row.entry_key))
    .filter(isStructuredAgentSessionStopNote)
}
