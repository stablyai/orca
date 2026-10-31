import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import type { InputPlaceQuery } from './journal-input-place-index'
import {
  JournalInputLineageOwner,
  type JournalInputContext,
  type JournalInputLineage
} from './journal-input-lineage'
import { JournalInputCardIndex } from './journal-input-card-index'

export type JournalInputPlace = {
  context: JournalInputContext
  coordinate: AgentJournalCursor
  original?: AgentJournalCursor
  witness?: QueuedMessageRow
}

/** Own admission places and shared command witnesses are reconstructed by the journal fold. */
export class JournalInputOrder {
  private legacyPlaces = 0
  private readonly witnesses = new Map<string, number>()
  private readonly recoveryOwed = new Set<string>()
  private readonly places = new Map<string, JournalInputPlace>()
  private readonly unsettled = new Map<string, AgentJournalSubmission>()
  private readonly queued = new Map<string, AgentJournalSubmission>()
  private readonly entered = new Map<string, AgentJournalSubmission>()
  private readonly overrides = new Map<string, AgentJournalSubmission>()
  private pending: readonly AgentJournalSubmission[] | undefined
  readonly lineage = new JournalInputLineageOwner()
  private readonly cards = new JournalInputCardIndex(this.lineage)
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {}

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    if (row.kind === 'dispatch' && row.keptAsQueuedMessageId) {
      const place = this.places.get(row.clientMessageId)
      if (place && !this.lineage.cards.has(row.keptAsQueuedMessageId)) {
        this.lineage.cards.set(row.keptAsQueuedMessageId, {
          messageId: row.keptAsQueuedMessageId,
          introduced: place.context.cut,
          aliases: []
        })
      }
    }
    this.receiptCount = state.receipts.size
    this.queueRevision = state.queue.revision
    if (row.kind === 'epoch' && row.inputOrderLineage) {
      this.lineage.load(row.inputOrderLineage)
    }
    this.lineage.observe(row.seq)
    if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
      return
    }
    const coordinate = { epoch: row.epoch, sequence: row.seq }
    this.cards.ensure(state)
    const context: JournalInputContext = row.inputOrderContext ?? {
      source: coordinate,
      basis: 'legacy',
      cut: this.lineage.at(row.seq)
    }
    if (context.basis === 'legacy') {
      this.lineage.protect(context.cut)
    }
    const original =
      context.basis === 'legacy' ? this.originalAcceptance?.(row.clientMessageId) : undefined
    const place: JournalInputPlace = { coordinate, context, ...(original ? { original } : {}) }
    const carried = row.inputOrderContext?.basis === 'legacy'
    const exposed = carried ? this.cards.command() : undefined
    const selected = carried
      ? exposed && this.cards.relation(exposed, place)
        ? exposed
        : undefined
      : !row.inputOrderContext
        ? this.cards.queryCurrent(place).command
        : this.cards.query(place).command
    const witness = selected ? state.queue.cards.get(selected.messageId) : undefined
    if (this.places.has(row.clientMessageId)) {
      this.releasePlace(state, row.clientMessageId, false)
    }
    if (context.basis === 'legacy') {
      this.legacyPlaces++
    }
    if (witness) {
      this.witnesses.set(witness.messageId, (this.witnesses.get(witness.messageId) ?? 0) + 1)
    }
    this.places.set(row.clientMessageId, { ...place, ...(witness ? { witness } : {}) })
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
    const override = this.overrides.delete(id)
    if (queued || override) {
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

  place(id: string): JournalInputPlace | undefined {
    return this.places.get(id)
  }
  forced(id: string): boolean {
    return this.places.get(id)?.witness !== undefined
  }
  firstQueued(): AgentJournalSubmission | undefined {
    return this.queued.values().next().value
  }
  explicitSend(): AgentJournalSubmission | undefined {
    return this.overrides.values().next().value
  }
  enteredSubmissions(): Iterable<AgentJournalSubmission> {
    return this.entered.values()
  }
  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return (this.pending ??= [...this.unsettled.values()])
  }
  version(): number {
    return this.revision
  }

  predecessors(state: JournalReducerState, id: string): InputPlaceQuery {
    this.cards.ensure(state)
    const place = this.places.get(id)
    return place?.witness ? this.cards.query(place) : { position: -Infinity }
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.cards.queueChanged(state, prior, card)
    if (
      card.state === 'withdrawn' &&
      this.legacyPlaces === 0 &&
      !this.witnesses.has(card.messageId)
    ) {
      this.lineage.cards.delete(card.messageId)
    }
  }

  replacementLineage(ids: ReadonlySet<string>): JournalInputLineage {
    return this.lineage.snapshot([...this.places.values()], ids)
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
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
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider === 'orca') {
      this.refresh(state, identity.clientMessageId)
    }
  }

  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    if (entry?.dispatchState === 'pending' || entry?.dispatchState === 'unknown') {
      if (this.unsettled.get(id) !== entry) {
        this.unsettled.set(id, entry)
        this.pending = undefined
        this.revision++
      }
    } else if (this.unsettled.delete(id)) {
      this.pending = undefined
      this.revision++
    }
    if (entry?.dispatchState !== 'pending') {
      this.releasePlace(state, id)
    }
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.recoveryOwed.has(id)) {
        this.queued.set(id, entry)
      }
      this.entered.delete(id)
      if (
        !this.recoveryOwed.has(id) &&
        entry.origin === 'client' &&
        entry.queuedMessageId !== undefined
      ) {
        this.overrides.set(id, entry)
      }
    } else {
      this.recoveryOwed.delete(id)
      this.queued.delete(id)
      this.overrides.delete(id)
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

  private releasePlace(state: JournalReducerState, id: string, compact = true): void {
    const place = this.places.get(id)
    if (place && this.places.delete(id)) {
      if (place.witness) {
        const witnessId = place.witness.messageId
        const references = this.witnesses.get(witnessId)! - 1
        if (references) {
          this.witnesses.set(witnessId, references)
        } else {
          this.witnesses.delete(witnessId)
          if (this.legacyPlaces === 0 && state.queue.cards.get(witnessId)?.state === 'withdrawn') {
            this.lineage.cards.delete(witnessId)
          }
        }
      }
      if (place.context.basis === 'legacy' && --this.legacyPlaces === 0 && compact) {
        this.lineage.releaseHistory(
          (cardId) =>
            state.queue.cards.get(cardId)?.state !== 'withdrawn' || this.witnesses.has(cardId)
        )
        this.cards.releaseHistory()
      }
    }
  }

  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const place = this.places.get(submission.clientMessageId)
    return Boolean(place?.witness && this.cards.relation(card, place))
  }
}
