import type Database from '../../sqlite/sync-database'
import {
  restoredJournalDomainSubmissions,
  readImportedRetiredAcceptances,
  type JournalDomainImportAttempt
} from './journal-domain-import-submissions'
export type { JournalDomainImportAttempt } from './journal-domain-import-submissions'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { restoreJournal } from './replay/journal-open'
import { failLoadOnUnloadableJournal } from './replay/journal-open-failure'
import { restoredJournalPersonAcceptance } from './replay/journal-historical-inputs'
import { readJournalLegacyCards } from './queued-messages/journal-queue-import'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { queuedHandOffInDoubt } from './projection/journal-dispatch-settlement'
import {
  foldQueuedHandOffInDoubt,
  placeQueuedHandOffInDoubt
} from './submissions/journal-submission-fold'
import {
  journalInputPresentationMember,
  type JournalInputEnd
} from './input-order/journal-input-obligations'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalOutcomeSource } from './outcomes/journal-outcome-format'
import { memoryJournalMap, memoryJournalSet } from './journal-memory-collections'
import type { JournalReducerState } from './projection/journal-reducer'
import { journalDomainStopNote } from './journal-domain-stop-notes'
import { placeImportedLegacyQueue } from './journal-domain-import-queue'
import type { JournalQueuePauseMarks } from './queued-messages/queued-message-pause-marks'
import type { JournalHistoryOrigin } from './context-epochs/journal-history-origin'
import {
  isCommand,
  reportedTurnItemId,
  settledFailure
} from './queued-messages/journal-queue-failure-policy'

/** The chat head, written last: its row is the chat's ready mark. */
export type JournalDomainImportHead = {
  lastSequence: number
  highestFence: number
  contextBoundary: number
  lastActivityAt: number
  derivedTurnItemId: string | null
  historyOrigin: JournalHistoryOrigin | null
  acceptedHandoverSequence?: number
  queuePauseMarks: Omit<JournalQueuePauseMarks, 'cleared'> & {
    cleared?: Omit<NonNullable<JournalQueuePauseMarks['cleared']>, 'messageIds'>
  }
  queueFailureBoundary: number
}

export type JournalDomainImportItem = {
  ordinal: number
  ownerFence: number
  executionOwner: number | null
  hidden: boolean
  item: AgentJournalRenderItem
  displayed?: AgentJournalRenderItem
  turnItemId: string | null
  originalStopNoteJson: string | null
  queueCommandTurn: boolean
  queueFailedOutcome: boolean
  queueFailedAt: number
  queueFailureWitnessedThrough: number
  queueFailureReportTurnItemId: string | null
}

/** Typed rows only; each kind has exactly one named insertion on the writer. */
export type JournalDomainImportPage =
  | { kind: 'items'; rows: JournalDomainImportItem[] }
  | { kind: 'tombstones'; rows: { itemId: string; revision: number }[] }
  | {
      kind: 'aliases'
      rows: { providerItemId: string; itemId: string; echo?: { value: unknown } }[]
    }
  | { kind: 'attempts'; rows: JournalDomainImportAttempt[] }
  | { kind: 'receipts'; rows: AgentJournalAcceptanceReceipt[] }
  | { kind: 'cards'; rows: QueuedMessageRow[] }
  | { kind: 'activity'; rows: { fence: number; lastActivityAt: number }[] }
  | { kind: 'queue-clear-members'; rows: { messageId: string }[] }
  | { kind: 'removed-turns'; rows: { turnId: string }[] }
  | { kind: 'settlements'; rows: { settlementId: string }[] }
  | {
      kind: 'input-end-observations'
      rows: { sourceItemKey: string; observation: JournalInputEnd }[]
    }

export type JournalDomainImportHeader = {
  sessionId: string
  workspaceId: string
  epoch: string
  head: JournalDomainImportHead
}

export type JournalDomainImport = JournalDomainImportHeader & {
  pages: Generator<JournalDomainImportPage>
}

const PAGE_ROWS = 512
const PAGE_BYTES = 1024 * 1024

/**
 * Restores a chat's frozen copied source once, as an open interprets it, and returns its current
 * domain records as bounded typed pages. The source never changes before its chat is ready, so
 * every read is its own short statement: no transaction may span the restore and pin the WAL.
 * Returns null for a chat with nothing saved; its first open founds the epoch.
 */
export function prepareJournalDomainImport(
  db: Database.Database,
  sessionId: string
): JournalDomainImport | null {
  if (db.isTransaction) {
    throw new Error('journal domain import reads its frozen source outside a transaction')
  }
  const loaded = restoreJournal(db, sessionId)
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    return null
  }
  failLoadOnUnloadableJournal(sessionId, loaded)
  const { state } = loaded
  const { cleared, ...pauseMarks } = state.queuePauseMarks
  const cards = currentCards(db, state)
  const personal = restoredJournalPersonAcceptance(
    db,
    state,
    journalOutcomeSource(db, sessionId, state.epoch) ?? undefined,
    cards
  )
  placeImportedLegacyQueue(state, cards, personal)
  return {
    sessionId,
    workspaceId: String(
      db.prepare('SELECT workspace_id FROM journal_sessions WHERE session_id=?').get(sessionId)!
        .workspace_id
    ),
    epoch: state.epoch,
    head: {
      lastSequence: state.lastSequence,
      highestFence: state.highestFence,
      contextBoundary: state.contextBoundary,
      lastActivityAt: state.lastActivityAt,
      derivedTurnItemId: state.derivedTurnScope.snapshot(),
      historyOrigin: state.historyOrigin,
      acceptedHandoverSequence: journalInputOrder(state).links.acceptedHandover(),
      queuePauseMarks: {
        ...pauseMarks,
        ...(cleared
          ? {
              cleared: {
                sequence: cleared.sequence,
                operationId: cleared.operationId,
                ...(cleared.lifted ? { lifted: true as const } : {})
              }
            }
          : {})
      },
      queueFailureBoundary: journalInputOrder(state).newestTurn.importBoundary()
    },
    pages: importPages(state, cards, personal, readImportedRetiredAcceptances(db, state))
  }
}

/**
 * Restored cards plus legacy-table cards the journal never recorded, adopted as today's open
 * adopts them: an in-doubt hand-off they consumed reads as sent, at its hand-off place.
 */
function currentCards(
  db: Database.Database,
  state: JournalReducerState
): Map<string, QueuedMessageRow> {
  const cards = new Map(memoryJournalMap(state.queue.cards))
  for (const card of readJournalLegacyCards(db, state)) {
    if (cards.has(card.messageId)) {
      continue
    }
    cards.set(card.messageId, card)
    const id = card.consumedAs ?? card.recovers
    const send = id ? state.submissions.get(id) : undefined
    if (send && queuedHandOffInDoubt(send)) {
      state.inputs.presentations.set(send.clientMessageId, card)
      foldQueuedHandOffInDoubt(send)
      placeQueuedHandOffInDoubt(state, send)
    }
  }
  return cards
}

function* importPages(
  state: JournalReducerState,
  cards: ReadonlyMap<string, QueuedMessageRow>,
  personal: (submission: AgentJournalSubmission) => boolean,
  retiredAccepted: ReadonlyMap<string, AgentJournalSubmission>
): Generator<JournalDomainImportPage> {
  // Ties keep the restored map order, exactly as the restored timeline sorts them.
  const items = [...memoryJournalMap(state.items)].toSorted(([, a], [, b]) =>
    compareAgentJournalItems(a, b)
  )
  yield* paged(
    'items',
    items.map(([key, item], index) => {
      const stop = journalDomainStopNote(item, (id) => state.items.get(id))
      return {
        ordinal: index + 1,
        ownerFence: state.itemFences.get(key) ?? 0,
        executionOwner: state.itemExecutionOwners.get(key) ?? null,
        hidden: !journalInputPresentationMember(state, key),
        queueCommandTurn: isCommand(item),
        queueFailedOutcome: settledFailure(item),
        queueFailedAt: journalInputOrder(state).newestTurn.importFailure(key).failedAt,
        queueFailureWitnessedThrough:
          journalInputOrder(state).newestTurn.importFailure(key).witnessedThrough,
        queueFailureReportTurnItemId: (() => {
          const report = reportedTurnItemId(item)
          return report === null ? null : (state.aliases.get(report) ?? report)
        })(),
        ...stop,
        item,
        ...(stop.item === item ? {} : { displayed: stop.item })
      }
    })
  )
  yield* paged(
    'tombstones',
    [...memoryJournalMap(state.tombstones)].map(([itemId, revision]) => ({ itemId, revision }))
  )
  const aliases = new Map(memoryJournalMap(state.aliases))
  const echoes = memoryJournalMap(state.itemEchoes)
  yield* paged(
    'aliases',
    [...new Set([...aliases.keys(), ...echoes.keys()])].map((providerItemId) => ({
      providerItemId,
      itemId: aliases.get(providerItemId) ?? providerItemId,
      ...(echoes.has(providerItemId) ? { echo: { value: echoes.get(providerItemId) } } : {})
    }))
  )
  yield* paged('attempts', restoredJournalDomainSubmissions(state, personal, retiredAccepted))
  yield* paged(
    'removed-turns',
    [...memoryJournalSet(state.removedTurnIds)].map((turnId) => ({ turnId }))
  )
  yield* paged('receipts', [...memoryJournalMap(state.receipts).values()])
  yield* paged(
    'settlements',
    [...memoryJournalSet(state.appliedSettlementIds)].map((settlementId) => ({ settlementId }))
  )
  yield* paged(
    'input-end-observations',
    [...memoryJournalMap(state.inputs.ends)].map(([sourceItemKey, observation]) => ({
      sourceItemKey,
      observation
    }))
  )
  yield* paged('cards', [...cards.values()])
  yield* paged(
    'queue-clear-members',
    (state.queuePauseMarks.cleared?.messageIds ?? []).map((messageId) => ({ messageId }))
  )
  yield* paged(
    'activity',
    [...memoryJournalMap(state.providerActivityAt)].map(([fence, lastActivityAt]) => ({
      fence,
      lastActivityAt
    }))
  )
}

/** At most 512 rows or 1 MiB per page; one larger legal row crosses the port alone. */
function* paged<Kind extends JournalDomainImportPage['kind']>(
  kind: Kind,
  rows: Extract<JournalDomainImportPage, { kind: Kind }>['rows']
): Generator<JournalDomainImportPage> {
  let page: unknown[] = []
  let bytes = 0
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row))
    if (page.length > 0 && (page.length === PAGE_ROWS || bytes + size > PAGE_BYTES)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page holds only rows of this kind.
      yield { kind, rows: page } as JournalDomainImportPage
      page = []
      bytes = 0
    }
    page.push(row)
    bytes += size
  }
  if (page.length > 0) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page holds only rows of this kind.
    yield { kind, rows: page } as JournalDomainImportPage
  }
}
