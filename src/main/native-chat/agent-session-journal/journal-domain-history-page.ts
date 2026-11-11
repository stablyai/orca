import { boundedFrameItem } from '../agent-session-wire/publication/history/agent-session-bounded-frame-item'
import {
  agentJournalItemForWire,
  CLIENT_HISTORY_READER
} from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import type Database from '../../sqlite/sync-database'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem,
  resolveHistoryLimit,
  type HistoryReader,
  type HistoryItemForm
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { buildAgentSessionHistoryPage } from '../agent-session-wire/publication/history/agent-session-history-page-result'
import {
  queuedImageSubmissionPresenter,
  unchangedQueuedImageSubmission,
  type QueuedImageHistoryPolicy
} from '../agent-session-wire/publication/history/agent-session-queued-image-reader'
import { JournalSqlScope } from './journal-sql-scope'
import { readJournalDomainSourceHeaders } from './journal-domain-source-items'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import {
  latestTurnItem,
  readJournalDomainForwardHistory,
  readJournalDomainHistorySnapshot,
  itemSubmissions
} from './journal-domain-history-after'
import { readJournalDomainHistoryRoster } from './journal-domain-history-roster'
import { formJournalDomainHistoryGroups } from './journal-domain-history-groups'
import {
  admitJournalDomainHistoryGroups,
  readJournalDomainHistoryEnvelope,
  journalDomainSequenceGroups,
  selectJournalDomainHistoryWindow
} from './journal-domain-history-window'

export type JournalDomainHistoryRequest = Omit<AgentSessionHistoryRequest, 'direction'> & {
  direction: AgentSessionHistoryRequest['direction'] | 'hydrate'
  fence?: number
  scope?: 'every-agent' | 'own-agent'
  rowReplay?: boolean
  reader?: {
    form: 'client' | 'bounded'
    budgetBytes?: number
    queuedImages?: QueuedImageHistoryPolicy
  }
}

export type JournalDomainHistoryHead = {
  sessionId: string
  epoch: string
  /** Public context identity of the physical epoch. */
  cursor: AgentJournalSnapshot['cursor']
  retainedSequence: number
}

type HistoryReaderForm = Pick<HistoryReader, 'form' | 'budgetBytes'> & {
  presentSubmission?: (send: AgentJournalSubmission) => AgentJournalSubmission
}

/** The caller owns a readonly connection; head, headers, bodies and any reset share one snapshot. */
export function readJournalDomainHistoryPage(
  db: Database.Database,
  request: JournalDomainHistoryRequest,
  reader: HistoryReaderForm = request.reader?.form === 'bounded'
    ? {
        form: (item) => boundedFrameItem(agentJournalItemForWire(item)),
        budgetBytes: request.reader.budgetBytes ?? BOUNDED_FRAME_CONTENT_BUDGET_BYTES
      }
    : {
        ...CLIENT_HISTORY_READER,
        budgetBytes: request.reader?.budgetBytes ?? CLIENT_HISTORY_READER.budgetBytes
      }
): AgentSessionHistoryResult {
  db.exec('BEGIN')
  try {
    const result = readHistory(db, readHead(db, request.sessionId), request, {
      ...reader,
      ...(request.reader?.queuedImages
        ? { presentSubmission: queuedImageSubmissionPresenter(request.reader.queuedImages) }
        : {})
    })
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
    WHERE session_id=? AND epoch IS NOT NULL`)
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
      (ids, forms, states, ordinals, orderedIds) =>
        readJournalDomainHistorySnapshot(
          db,
          head,
          ids,
          queuedImageSourceIds(request),
          reader.presentSubmission,
          forms,
          states,
          ordinals,
          orderedIds
        ),
      reset,
      request.reader?.queuedImages,
      reader.form === CLIENT_HISTORY_READER.form &&
        (reader.presentSubmission === undefined ||
          reader.presentSubmission === unchangedQueuedImageSubmission)
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
  const sourceWindow = (window: Parameters<typeof readJournalDomainSourceHeaders>[2]) =>
    readJournalDomainSourceHeaders(
      new JournalSqlScope(db, ...prefix),
      queuedImageSourceIds(request) ?? [],
      { ...window, own: request.scope === 'own-agent' }
    )
  let sources = sourceWindow({ before: end, limit: 2 * limit })
  if (sources.length === 2 * limit) {
    const boundary = sources.at(-1)!.sequence
    sources = [
      ...sources.filter((source) => source.sequence > boundary),
      ...sourceWindow({ before: boundary + 1, from: boundary })
    ]
  }
  const window = selectJournalDomainHistoryWindow(db, where, prefix, end, limit, sources)
  const forms = new Map<string, HistoryItemForm>()
  const admitted = request.reader?.queuedImages
    ? { groups: [...journalDomainSequenceGroups(window)], oversized: false }
    : admitJournalDomainHistoryGroups(window, reader.budgetBytes, db, head, forms)
  const { groups, submissions } = admitted.oversized
    ? {
        groups: [
          admitted.groups[0]!.map((header) =>
            oversizedHistoryItem(readJournalDomainHistoryEnvelope(db, prefix, header.itemId))
          )
        ],
        submissions: itemSubmissions(
          db,
          head,
          admitted.groups[0]!.map((header) => header.itemId)
        )
      }
    : formJournalDomainHistoryGroups(db, head, admitted.groups, reader, forms)
  const items = groups.toReversed().flat()
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
    hasOlder:
      !!db
        .prepare(`SELECT 1 FROM journal_items WHERE ${where} AND sequence<? LIMIT 1`)
        .get(...prefix, oldest) || sourceWindow({ before: oldest, limit: 1 }).length > 0,
    hasNewer:
      cursor !== undefined &&
      (!!db
        .prepare(`SELECT 1 FROM journal_items WHERE ${where} AND sequence>=? LIMIT 1`)
        .get(...prefix, end) ||
        sourceWindow({ from: end, limit: 1 }).length > 0),
    fallbackCursor: cursor ?? { epoch: head.cursor.epoch, sequence: 0 },
    nextCursor: items[0] ? { epoch: head.cursor.epoch, sequence: items[0].sequence } : undefined,
    fence: request.fence,
    subagentRoster: readJournalDomainHistoryRoster(db, prefix, items)
  })
}

function queuedImageSourceIds(request: JournalDomainHistoryRequest): string[] | undefined {
  return request.reader?.queuedImages?.ids.filter(([, active]) => active).map(([id]) => id)
}
