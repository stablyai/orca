import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { JournalSubmissionIndex } from './journal-submission-index'
import { JournalNewestTurn } from './journal-newest-turn'
import { JournalRunningTools } from './journal-running-tools'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { JournalInputEvidence } from './journal-input-evidence'
import { LegacyQueueOrderReader } from './legacy-queue-order-reader'
import { JournalInputCardIndex } from './journal-input-card-index'

import { getJournalInputOrder, setJournalInputOrder } from './journal-input-order-registry'

export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputOrder {
  const owner = new JournalInputOrder(state, originalAcceptance)
  setJournalInputOrder(state, owner)
  return owner
}
export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return getJournalInputOrder(state) ?? initializeJournalInputOrder(state)
}

/** Delivery evidence and the current hand-off; every other waiting input has a queue row. */
export class JournalInputOrder extends JournalInputEvidence {
  /** Present only while an old saved queue is being decoded and converted. */
  legacy: LegacyQueueOrderReader | undefined
  private readonly recoveryOwed = new Set<string>()
  private readonly unsettled = new JournalSubmissionIndex()
  // Recovered unknown sends stay unsettled forever; only pending ones can still be accepted.
  private readonly sending = new JournalSubmissionIndex()
  private readonly queued = new Map<string, AgentJournalSubmission>()
  private readonly entered = new Map<string, AgentJournalSubmission>()
  readonly cards: JournalInputCardIndex
  readonly runningTools: JournalRunningTools
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    state: JournalReducerState,
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined,
    readonly newestTurn = new JournalNewestTurn(state)
  ) {
    super(state)
    this.cards = new JournalInputCardIndex(journalInputOrder)
    this.runningTools = new JournalRunningTools(state)
  }

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    this.receiptCount = state.receipts.size
    this.queueRevision = state.queue.revision
    this.legacy?.beforeRow(state, row)
  }
  beginReconstruction(): void {
    this.legacy ??= new LegacyQueueOrderReader(
      this.state,
      journalInputOrder,
      this.originalAcceptance
    )
    this.legacy.beginReconstruction()
  }
  finishReconstruction(state: JournalReducerState): void {
    this.legacy?.finishReconstruction(state)
  }
  restore(state: JournalReducerState): void {
    this.legacy?.restore(state)
    this.cards.ensure(state)
    for (const id of state.submissions.keys()) {
      this.refresh(state, id)
    }
  }
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    this.legacy?.overlay(state, rows)
    this.cards.overlay(state, rows)
  }
  introduceOverlays(state: JournalReducerState): void {
    this.legacy?.cards.introduceOverlays((card) =>
      this.legacy?.queueChanged(state, undefined, card)
    )
  }
  completeQueueConversion(state: JournalReducerState): void {
    this.legacy = undefined
    state.inputEntries.clear()
    state.inputCards.clear()
  }
  queueFormat(): 2 | 3 {
    return this.legacy ? 2 : 3
  }

  markOpeningRecovery(): void {
    for (const entry of this.unsettled.values()) {
      if (isQueuedAgentJournalSubmission(entry)) {
        this.markRecoveryPending(entry.clientMessageId)
      }
    }
  }

  markRecoveryPending(id: string): void {
    this.recoveryOwed.add(id)
    const queued = this.queued.delete(id)
    if (queued) {
      this.revision++
    }
  }
  recoveryPending(id: string): boolean {
    return this.recoveryOwed.has(id)
  }
  carryRecovery(previous: JournalInputOrder): void {
    for (const id of previous.recoveryOwed) {
      if (this.queued.has(id)) {
        this.markRecoveryPending(id)
      }
    }
  }

  firstQueued(): AgentJournalSubmission | undefined {
    return this.queued.values().next().value
  }
  enteredSubmissions(): Iterable<AgentJournalSubmission> {
    return this.entered.values()
  }
  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return this.unsettled.list()
  }
  sendingSubmissions(): readonly AgentJournalSubmission[] {
    return this.sending.list()
  }
  version(): number {
    return this.revision
  }

  liveCards(state: JournalReducerState): Iterable<QueuedMessageRow> {
    this.cards.ensure(state)
    return this.cards.live()
  }
  cardVersion(state: JournalReducerState): number {
    this.cards.ensure(state)
    return this.cards.version()
  }
  cardBounds(state: JournalReducerState): { first: number; last: number } {
    this.cards.ensure(state)
    return this.cards.bounds()
  }
  head(state: JournalReducerState, floor: AgentJournalCursor | null): QueuedMessageRow | undefined {
    this.cards.ensure(state, floor)
    return this.cards.head()
  }
  paused(
    state: JournalReducerState,
    card: QueuedMessageRow,
    floor: AgentJournalCursor | null
  ): boolean {
    this.cards.ensure(state, floor)
    return this.cards.paused(card)
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.legacy?.queueChanged(state, prior, card)
    this.cards.ensure(state)
    this.cards.indexCard(state, card)
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    this.newestTurn.afterRow(state, row)
    this.runningTools.afterRow(state, row)
    this.legacy?.afterRow(state, row)
    if (
      row.kind === 'submission' ||
      row.kind === 'dispatch' ||
      row.kind === 'tombstone' ||
      this.receiptCount !== state.receipts.size ||
      this.queueRevision !== state.queue.revision
    ) {
      this.revision++
    }
    if (row.kind === 'submission' || row.kind === 'dispatch') {
      this.refresh(state, row.clientMessageId)
    } else if (row.kind === 'tombstone' && row.retireSubmission) {
      this.refreshItem(state, row.itemId)
    } else if (row.kind === 'item') {
      this.refreshItem(state, state.aliases.get(row.itemId) ?? row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        this.refreshItem(state, state.aliases.get(mutation.itemId) ?? mutation.itemId)
      }
    } else if (row.kind === 'queue') {
      const id = state.queue.cards.get(row.messageId)?.consumedAs
      if (id) {
        this.refresh(state, id)
      }
    }
  }

  private refreshItem(state: JournalReducerState, itemId: string): void {
    const id = this.inputIds.get(itemId)
    if (id !== undefined) {
      this.refresh(state, id)
    }
  }

  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    this.refreshInputEvidence(state, id, entry)
    this.refreshLink(id)
    const dispatch = entry?.dispatchState
    if (this.unsettled.keep(id, entry, dispatch === 'pending' || dispatch === 'unknown')) {
      this.revision++
    }
    this.sending.keep(id, entry, dispatch === 'pending')
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.recoveryOwed.has(id)) {
        this.queued.set(id, entry)
      }
      this.entered.delete(id)
    } else {
      this.recoveryOwed.delete(id)
      this.queued.delete(id)
      if (entry && (entry.dispatchState === 'pending' || entry.dispatchState === 'unknown')) {
        this.entered.set(id, entry)
      } else {
        this.entered.delete(id)
      }
    }
    if (entry?.queuedMessageId) {
      const card = state.queue.cards.get(entry.queuedMessageId)
      if (card?.consumedAs === id) {
        this.cards.indexCard(state, card)
      }
    }
  }
}
