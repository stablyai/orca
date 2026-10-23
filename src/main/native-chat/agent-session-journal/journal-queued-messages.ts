import { journalInputAttemptEnded } from './journal-input-obligations'
// The queue's one view and its writes. A card is folded from the chat's own rows
// (`journal-queue-fold.ts`), so every change to one is a journal row on the journal's own lane,
// committed with whatever else the action writes: the queue keeps no second copy to fall behind.
// Drafts are NEVER owed work: nothing here feeds working status, teardown, or the idle sweep.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import {
  journalQueueRowBuilder,
  type JournalQueueCardChange,
  type JournalQueueRow
} from './journal-queue-events'
import { LegacyQueuedCards } from './journal-queue-import'
import { queuedChangeOf, queueNeedsReopen } from './journal-queue-retention'
import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps, JournalSubmissionConsume } from './journal-store-contracts'
import {
  deriveQueuePauses,
  journalUserStopInForce,
  nextSendableQueuedCard,
  type DerivedQueuePause,
  type JournalQueuePauseMarks
} from './queued-message-pause'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageHoldReason,
  type QueuedMessageRow
} from './queued-message-table'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { QueuedMessageEditLeases } from './queued-message-edit-leases'
import { queuedMessageUpdateDecision, type QueuedMessageUpdate } from './queued-message-update'
import {
  adoptUnconfirmedRecovery,
  unconfirmedRecoveryCards,
  type JournalRecoveryWork
} from './journal-unconfirmed-recovery'
import type { JournalReducerState } from './journal-reducer'

/** Card rows to write in one transaction, with what must commit beside them. */
export type JournalQueuePlan = {
  rows: ((seq: number, ts: number) => JournalQueueRow)[]
  receipt: JournalOperationReceipt
}

export class JournalQueuedMessages {
  readonly editLeases = new QueuedMessageEditLeases(() => this.list())
  private readonly legacy: LegacyQueuedCards
  recoveryWork: () => JournalRecoveryWork | null = () => null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {
    this.legacy = new LegacyQueuedCards(deps)
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  displayState(): JournalReducerState {
    return this.deps.state()
  }

  /** Moves with every card change, so publication memos recompute only when they must. */
  revision(): string {
    const { epoch, queue } = this.deps.state()
    return `${epoch}:${queue.revision}:${this.legacy.key()}:${this.deps.state().inputs.revision}:${this.recoveryWork()?.recoveryViewKey() ?? ''}`
  }

  /** The cards every reader sees, in queue order: the fold's, and any an earlier build wrote that
   *  are not in the journal yet (`journal-queue-import.ts`). */
  list(): readonly QueuedMessageRow[] {
    const key = this.revision()
    if (this.viewed?.key !== key) {
      const cards = [...this.deps.state().queue.cards.values(), ...this.legacy.cards()]
      cards.push(...unconfirmedRecoveryCards(this.deps.state(), cards, this.recoveryWork()))
      this.viewed = { key, cards: cards.sort((a, b) => a.position - b.position) }
    }
    return this.viewed.cards
  }

  isDerivedRecovery(messageId: string): boolean {
    return messageId.startsWith('recovery:') && !this.deps.state().queue.cards.has(messageId)
  }

  attemptEnded(clientMessageId: string): boolean {
    const state = this.deps.state()
    const send = state.submissions.get(clientMessageId)
    return send !== undefined && journalInputAttemptEnded(state, send, this.recoveryWork())
  }

  get(messageId: string): QueuedMessageRow | null {
    return this.list().find((card) => card.messageId === messageId) ?? null
  }

  /** Attachments and the send receipt commit with the card. */
  insert(
    input: {
      messageId: string
      body: AgentJournalMessageItem
      requireAttachments?: true
      holdReason?: QueuedMessageHoldReason
      options?: AgentSessionExecutionOptions
    },
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow> {
    const { messageId, body } = input
    const claims: JournalOperationReceipt = {
      write: (db) => this.deps.claimAttachments(db, body, input.requireAttachments === true),
      committed: () => {}
    }
    return this.write(
      () => {
        // One id, one card: admission replays a recorded operation before it gets here, so an
        // existing card is the same accept landing twice.
        if (this.get(messageId)) {
          return { changes: [], result: undefined }
        }
        const { epoch, lastSequence } = this.deps.state()
        const position = Math.max(0, ...this.list().map((card) => card.position)) + 1
        const change = {
          op: 'queued' as const,
          body,
          position,
          queuedAt: { epoch, sequence: lastSequence },
          ...(input.holdReason ? { holdReason: input.holdReason } : {}),
          ...(input.options ? { options: input.options } : {})
        }
        return { changes: [{ messageId, change }], result: undefined }
      },
      composeJournalOperationReceipts(claims, ...(receipt ? [receipt] : []))
    ).then(() => {
      const card = this.get(messageId)
      if (!card) {
        throw new Error('agent_session_queued_message_lost')
      }
      return card
    })
  }

  /** An in-place edit; a changed card spends every edit lease on its old body. Only uploads the
   *  old body did not name must still be stored, so a swept kept image never blocks a text fix;
   *  they are claimed in the edit's own transaction, which a gone one rolls back. */
  update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    let edit: { body: AgentJournalMessageItem; previous: AgentJournalMessageItem } | undefined
    const receipt: JournalOperationReceipt = {
      write: (db) => {
        if (edit) {
          this.deps.claimAttachments(db, edit.body, true, edit.previous)
        }
      },
      committed: () => this.editLeases.retire(input.messageId)
    }
    return this.write<AgentSessionQueuedMessageUpdateResult>(() => {
      edit = undefined
      const card = this.get(input.messageId)
      const decision = queuedMessageUpdateDecision(card, this.deps.sessionId, input)
      const derived =
        card?.recovers &&
        !this.deps.state().queue.cards.has(card.messageId) &&
        !this.legacy.adoption(card.messageId)
      if (decision.status !== 'ready') {
        const result =
          decision.status === 'unchanged' && derived
            ? { ...decision, status: 'updated' as const }
            : decision
        return { changes: [], result }
      }
      edit = { body: decision.body, previous: decision.previous }
      const { messageId } = input
      return {
        changes: [
          {
            messageId,
            change: derived
              ? { ...queuedChangeOf(card), body: decision.body }
              : { op: 'edited', body: decision.body }
          }
        ],
        result: { status: 'updated', messageId, fingerprint: decision.fingerprint }
      }
    }, receipt)
  }

  /** Hold waiting cards whose conversion failed; an explicit Send releases one. */
  hold(input: { messageIds: readonly string[]; reason: QueuedMessageHoldReason }): Promise<void> {
    return this.write(() => ({
      changes: input.messageIds.flatMap((messageId) => {
        const card = this.get(messageId)
        return card?.state === 'waiting' && card.holdReason !== input.reason
          ? [{ messageId, change: { op: 'held' as const, holdReason: input.reason } }]
          : []
      }),
      result: undefined
    }))
  }

  /** Withdraws the waiting and returned cards named; `receipt` commits with the withdrawal. */
  withdraw(
    messageIds: readonly string[],
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow[]> {
    if (messageIds.length === 0) {
      // Delete races and empty carries land here; neither may cost a write transaction.
      return Promise.resolve([])
    }
    return this.write<QueuedMessageRow[]>(() => {
      const cards = messageIds.flatMap((id) => {
        const card = this.get(id)
        return card && isUnsettledQueuedMessage(card) ? [card] : []
      })
      return {
        changes: cards.map(({ messageId }) => ({
          messageId,
          change: { op: 'withdrawn' as const }
        })),
        result: cards.map((card) => ({ ...card, state: 'withdrawn', holdReason: null }))
      }
    }, receipt)
  }

  /** Adopt each selected legacy witness with its action; deletion is optional cleanup after commit. */
  plan(changes: readonly JournalQueueCardChange[]): JournalQueuePlan {
    const rows: JournalQueuePlan['rows'] = []
    const adopted: string[] = []
    const witness = (id: string) => {
      const value = this.legacy.witness(id)
      if (value && !adopted.includes(value.messageId)) {
        rows.push(journalQueueRowBuilder(this.deps.state, value.messageId, value.change))
        adopted.push(value.messageId)
      }
    }
    for (const { messageId, change } of changes) {
      const source = this.get(messageId)?.recovers
      if (source) {
        witness(source)
      }
      const own = this.deps.state().queue.cards.has(messageId) || adopted.includes(messageId)
      const adoption = own
        ? null
        : (this.legacy.adoption(messageId) ??
          adoptUnconfirmedRecovery(this.list(), messageId, change))
      if (adoption) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, adoption))
        adopted.push(messageId)
      }
      if (change) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, change))
      }
    }
    return { rows, receipt: { write: () => {}, committed: () => this.legacy.cleanup(adopted) } }
  }

  proofWitness(clientMessageId: string): JournalQueuePlan['rows'] {
    const witness = this.legacy.witness(clientMessageId)
    return witness
      ? [journalQueueRowBuilder(this.deps.state, witness.messageId, witness.change)]
      : []
  }

  /** On the lane, before a hand-off's submission is written: the card is what the person acted
   *  on, and for the queue's own send still the one it sends next. Throws otherwise. */
  assertConsumable(
    input: JournalSubmissionConsume & { consumedAs: string; fingerprint: string }
  ): void {
    const card = this.get(input.messageId)
    const consumable =
      card !== null &&
      card.state === input.expect &&
      card.fingerprint === input.fingerprint &&
      input.consumedAs !== input.messageId
    if (consumable && input.yieldsToPause) {
      const cards = this.list()
      const held = this.editLeases.heldIds(cards)
      const next = nextSendableQueuedCard(this.derivePauses(cards), cards, held)
      if (next?.messageId === input.messageId) {
        return
      }
    } else if (consumable) {
      return
    }
    throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
  }

  /** The bulk move of an earlier build's cards, once per open (`LegacyQueuedCards.importAtOpen`). */
  importAtOpen(): Promise<void> {
    return this.legacy.importAtOpen()
  }

  /** The queue's pauses in force, derived from the fold and the cards (`queued-message-pause.ts`). */
  pauses(): DerivedQueuePause[] {
    return this.derivePauses(this.list())
  }

  /** A card waits, or is mid-hand-off and may come back to waiting: a chat that stops running
   *  marks it (`AgentSessionJournal.markQueueReopen`). */
  awaitReopenMark(): boolean {
    return queueNeedsReopen(this.list(), this.deps.state().submissions)
  }

  /** The person's Stop still pausing the queue, if any (`journalUserStopInForce`). */
  userStopInForce(): JournalQueuePauseMarks['latestStop'] {
    const state = this.deps.state()
    return journalUserStopInForce(state.queuePauseMarks, state.latestAcceptedTurnSequence)
  }

  private derivePauses(cards: readonly QueuedMessageRow[]): DerivedQueuePause[] {
    const state = this.deps.state()
    return deriveQueuePauses({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      cards,
      reopenFloor: this.deps.reopenFloor()
    })
  }

  /** One write of card changes, planned at its own turn on the journal's lane so it reads every
   *  write ahead of it; `receipt` commits with the rows, and nothing is written for no change. */
  private write<T>(
    plan: () => { changes: readonly JournalQueueCardChange[]; result: T },
    receipt?: JournalOperationReceipt
  ): Promise<T> {
    let planned: { result: T; plan: JournalQueuePlan } | undefined
    return this.deps.writer
      .enqueueRows(
        () => {
          const next = plan()
          planned = { result: next.result, plan: this.plan(next.changes) }
          return planned.plan.rows
        },
        {
          write: (db, row) => {
            planned?.plan.receipt.write(db, row)
            receipt?.write(db, row)
          },
          committed: () => {
            planned?.plan.receipt.committed()
            receipt?.committed()
          }
        }
      )
      .then(() => {
        if (!planned) {
          throw new Error('agent_session_queue_write_unplanned')
        }
        return planned.result
      })
  }
}
