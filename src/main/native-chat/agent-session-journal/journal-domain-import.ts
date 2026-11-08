import type Database from '../../sqlite/sync-database'
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
import { journalInputPresentationMember } from './input-order/journal-input-obligations'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalOutcomeSource } from './outcomes/journal-outcome-format'
import { memoryJournalMap } from './journal-memory-collections'
import type { JournalReducerState } from './projection/journal-reducer'

/** The chat head, written last: its row is the chat's ready mark. */
export type JournalDomainImportHead = {
  lastSequence: number
  highestFence: number
  contextBoundary: number
  lastActivityAt: number
}

export type JournalDomainImportItem = {
  ordinal: number
  ownerFence: number
  executionOwner: number | null
  hidden: boolean
  item: AgentJournalRenderItem
}

export type JournalDomainImportAttempt = {
  ordinal: number
  candidate: boolean
  admittedPersonal: boolean
  submission: AgentJournalSubmission
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

export type JournalDomainImportHeader = {
  sessionId: string
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
  const cards = currentCards(db, state)
  const personal = restoredJournalPersonAcceptance(
    db,
    state,
    journalOutcomeSource(db, sessionId, state.epoch) ?? undefined,
    cards
  )
  return {
    sessionId,
    epoch: state.epoch,
    head: {
      lastSequence: state.lastSequence,
      highestFence: state.highestFence,
      contextBoundary: state.contextBoundary,
      lastActivityAt: state.lastActivityAt
    },
    pages: importPages(state, cards, personal)
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
  personal: (submission: AgentJournalSubmission) => boolean
): Generator<JournalDomainImportPage> {
  // Ties keep the restored map order, exactly as the restored timeline sorts them.
  const items = [...memoryJournalMap(state.items)].toSorted(([, a], [, b]) =>
    compareAgentJournalItems(a, b)
  )
  yield* paged(
    'items',
    items.map(([key, item], index) => ({
      ordinal: index + 1,
      ownerFence: state.itemFences.get(key) ?? 0,
      executionOwner: state.itemExecutionOwners.get(key) ?? null,
      hidden: !journalInputPresentationMember(state, key),
      item
    }))
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
  const order = journalInputOrder(state)
  yield* paged(
    'attempts',
    [...memoryJournalMap(state.submissions).values()].map((submission) => ({
      ordinal: order.inputOrdinal(submission.clientMessageId),
      candidate: state.inputs.candidates.has(submission.clientMessageId),
      admittedPersonal: submission.queuedMessageId !== undefined && personal(submission),
      submission
    }))
  )
  yield* paged('receipts', [...memoryJournalMap(state.receipts).values()])
  yield* paged('cards', [...cards.values()])
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
