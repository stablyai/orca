import type Database from '../../sqlite/sync-database'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemSubagentId } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { namedSubagents } from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import {
  historyContentBytes,
  oversizedHistoryItem,
  resolveHistoryLimit,
  submissionBytesByItemId,
  type HistoryReader
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { buildAgentSessionHistoryPage } from '../agent-session-wire/publication/history/agent-session-history-page-result'
import { offPageSubagentRoster } from '../agent-session-wire/publication/history/agent-session-history-subagent-roster'
import { CLIENT_HISTORY_READER } from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { readJournalDomainForwardHistory } from './journal-domain-history-after'
import { projectJournalDomainStopNote } from './journal-domain-stop-notes'
import {
  journalDomainSequenceGroups,
  selectJournalDomainHistoryWindow
} from './journal-domain-history-window'

export type JournalDomainHistoryRequest = Omit<AgentSessionHistoryRequest, 'direction'> & {
  direction: AgentSessionHistoryRequest['direction'] | 'hydrate'
  fence?: number
  scope?: 'every-agent' | 'own-agent'
  rowReplay?: boolean
}

export type JournalDomainHistoryHead = {
  sessionId: string
  epoch: string
  /** Public context identity of the physical epoch. */
  cursor: AgentJournalCursor
  retainedSequence: number
}

type HistoryReaderForm = Pick<HistoryReader, 'form' | 'budgetBytes'>

/** The caller owns a readonly connection; head, headers, bodies and any reset share one snapshot. */
export function readJournalDomainHistoryPage(
  db: Database.Database,
  request: JournalDomainHistoryRequest,
  reader: HistoryReaderForm = CLIENT_HISTORY_READER
): AgentSessionHistoryResult {
  db.exec('BEGIN')
  try {
    const result = readHistory(db, readHead(db, request.sessionId), request, reader)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function readHead(db: Database.Database, sessionId: string): JournalDomainHistoryHead {
  const row = db
    .prepare(`SELECT epoch, last_sequence, retained_sequence, context_boundary FROM journal_chat_state
    WHERE session_id=?`)
    .get(sessionId)
  if (!row) {
    throw new Error('journal history targets a chat without domain state')
  }
  const epoch = String(row.epoch)
  return {
    sessionId,
    epoch,
    cursor: {
      epoch: journalContextEpoch(epoch, Number(row.context_boundary)),
      sequence: Number(row.last_sequence)
    },
    retainedSequence: Number(row.retained_sequence)
  }
}

function readHistory(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  request: JournalDomainHistoryRequest,
  reader: HistoryReaderForm
): AgentSessionHistoryResult {
  const reset = (
    reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ): AgentSessionHistoryResult => ({
    ok: false,
    reset: reason,
    page: historyPage(
      db,
      head,
      { ...request, direction: 'hydrate', fence: undefined, scope: 'every-agent' },
      reader
    )
  })
  if (request.direction === 'after') {
    return readJournalDomainForwardHistory(
      db,
      head,
      request.cursor,
      resolveHistoryLimit(request.limit),
      reader,
      latestTurnItem(db, head),
      (ids) => currentRows(db, head, ids),
      reset
    )
  }
  const cursor = request.direction === 'before' ? request.cursor : undefined
  if (cursor && cursor.epoch !== head.cursor.epoch) {
    return reset('epoch_changed')
  }
  if (cursor && cursor.sequence > head.cursor.sequence) {
    return reset('cursor_ahead')
  }
  return { ok: true, page: historyPage(db, head, request, reader) }
}

function historyPage(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  request: JournalDomainHistoryRequest,
  reader: HistoryReaderForm
): AgentSessionHistoryPage {
  const prefix = [head.sessionId, head.epoch] as const
  const cursor = request.direction === 'before' ? request.cursor : undefined
  const end = cursor?.sequence ?? Number.MAX_SAFE_INTEGER
  const where = `session_id=? AND epoch=? AND hidden=0${request.scope === 'own-agent' ? ' AND root=1' : ''}`
  const limit =
    request.direction === 'hydrate'
      ? AGENT_SESSION_HISTORY_MAX_LIMIT
      : resolveHistoryLimit(request.limit)
  const window = selectJournalDomainHistoryWindow(db, where, prefix, end, limit)
  const submissions = itemSubmissions(
    db,
    head,
    window.map((header) => header.itemId)
  )
  const sizes = submissionBytesByItemId(submissions)
  const body = db.prepare(
    'SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
  )
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (const group of journalDomainSequenceGroups(window)) {
    const formed = group.map((header) =>
      reader.form(
        projectJournalDomainStopNote(
          db,
          head,
          JSON.parse(String(body.get(...prefix, header.itemId)!.payload_json))
        )
      )
    )
    const bytes = historyContentBytes(formed, [], sizes)
    if (kept.length > 0 && total + bytes > reader.budgetBytes) {
      break
    }
    kept.push(
      formed.map(({ item }) => (bytes > reader.budgetBytes ? oversizedHistoryItem(item) : item))
    )
    total += bytes
    if (bytes > reader.budgetBytes) {
      break
    }
  }
  const items = kept.toReversed().flat()
  const oldest = items[0]?.sequence ?? end
  const turn = latestTurnItem(db, head)
  return buildAgentSessionHistoryPage({
    snapshot: {
      sessionId: head.sessionId,
      cursor: head.cursor,
      items: turn ? [turn] : [],
      submissions
    },
    direction: request.direction === 'hydrate' ? 'tail' : request.direction,
    items,
    hasOlder: !!db
      .prepare(`SELECT 1 FROM journal_items WHERE ${where} AND sequence<? LIMIT 1`)
      .get(...prefix, oldest),
    hasNewer:
      cursor !== undefined &&
      !!db
        .prepare(`SELECT 1 FROM journal_items WHERE ${where} AND sequence>=? LIMIT 1`)
        .get(...prefix, end),
    fallbackCursor: cursor ?? { epoch: head.cursor.epoch, sequence: 0 },
    nextCursor: items[0] ? { epoch: head.cursor.epoch, sequence: items[0].sequence } : undefined,
    fence: request.fence,
    subagentRoster: historyRoster(db, prefix, items)
  })
}

function latestTurnItem(
  db: Database.Database,
  head: JournalDomainHistoryHead
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
      AND turn_marker=1 ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
    .get(head.sessionId, head.epoch)
  return row ? JSON.parse(String(row.payload_json)) : null
}

/** Current attempts only, in submission order then stable admission ordinal. */
function itemSubmissions(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  itemIds: readonly string[]
): AgentJournalSubmission[] {
  return db
    .prepare(`SELECT attempt.payload_json FROM json_each(?) wanted
      CROSS JOIN journal_submission_attempts attempt
      WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1 AND attempt.item_id=wanted.value
      ORDER BY attempt.submitted_at, attempt.ordinal`)
    .all(JSON.stringify(itemIds), head.sessionId, head.epoch)
    .map((row) => JSON.parse(String(row.payload_json)))
}

function currentRows(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  ids: ReadonlySet<string>
): AgentJournalSnapshot {
  const wanted = [...ids]
  return {
    sessionId: head.sessionId,
    cursor: head.cursor,
    items: db
      .prepare(`SELECT item.payload_json FROM json_each(?) wanted
        CROSS JOIN journal_items item
        WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.hidden=0
        ORDER BY item.sequence, item.sequence_index, item.ordinal`)
      .all(JSON.stringify(wanted), head.sessionId, head.epoch)
      .map((row) => projectJournalDomainStopNote(db, head, JSON.parse(String(row.payload_json)))),
    submissions: itemSubmissions(db, head, wanted)
  }
}

/** Reads only root rows naming a subagent the page shows but does not name. */
function historyRoster(
  db: Database.Database,
  prefix: readonly [string, string],
  page: readonly AgentJournalRenderItem[]
) {
  const missing = new Set(page.map(agentJournalItemSubagentId).filter((id) => id !== null))
  for (const item of page) {
    if (item.agentId === undefined && item.body.kind === 'message') {
      for (const entry of item.body.blocks.flatMap(namedSubagents)) {
        missing.delete(entry.id)
      }
    }
  }
  if (missing.size === 0) {
    return undefined
  }
  const body = db.prepare(
    'SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
  )
  const named: AgentJournalRenderItem[] = []
  for (const row of db
    .prepare(`SELECT item_id, named_subagent_ids FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND named_subagent_ids IS NOT NULL
      ORDER BY sequence, sequence_index, ordinal`)
    .iterate(...prefix)) {
    const ids: string[] = JSON.parse(String(row.named_subagent_ids))
    if (!ids.some((id) => missing.has(id))) {
      continue
    }
    for (const id of ids) {
      missing.delete(id)
    }
    named.push(JSON.parse(String(body.get(...prefix, String(row.item_id))!.payload_json)))
    if (missing.size === 0 || named.length >= ROSTER_ROWS) {
      break
    }
  }
  return offPageSubagentRoster(named, page)
}

// The roster keeps at most 64 entries; each selected row adds at least one.
const ROSTER_ROWS = 64
