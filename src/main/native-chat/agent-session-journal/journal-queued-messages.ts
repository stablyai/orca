import type { JournalReducerState } from './journal-reducer'
import { journalInputAttemptEnded, type JournalInputWork } from './journal-input-obligations'
import { journalInputOrder } from './journal-input-order'
import { nextEligibleQueuedCard } from './journal-queue-mail-eligibility'
import { journalQueueAdoptionPlan } from './journal-queue-adoption-plan'
import { journalAttachmentClaimReceipt } from './journal-submission-hook'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type { JournalQueueCardChange, JournalQueueRow } from './journal-queue-events'
import { LegacyQueuedCards } from './journal-queue-import'
import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps, JournalSubmissionConsume } from './journal-store-contracts'
import {
  deriveQueuePauses,
  journalUserStopInForce,
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
import { queuedMessageMovePlan } from './queued-message-move'
// Fold cards from journal rows, without a second mutable copy. Drafts never count as active work.

export type JournalQueuePlan = {
  rows: ((seq: number, ts: number) => JournalQueueRow)[]
  receipt: JournalOperationReceipt
}

export class JournalQueuedMessages {
  readonly editLeases = new QueuedMessageEditLeases(
    () => this.list(),
    undefined,
    (id) => this.get(id)
  )
  private readonly legacy: LegacyQueuedCards
  inputWork: () => JournalInputWork | null = () => null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {
    this.legacy = new LegacyQueuedCards(deps)
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  inputState(): JournalReducerState {
    const state = this.deps.state()
    journalInputOrder(state).overlay(state, this.legacy.cards())
    return state
  }
  displayState(): JournalReducerState {
    this.inputState()
    return this.legacy.displayState()
  }

  revision(): string {
    const state = this.inputState()
    return `${state.epoch}:${state.queue.revision}:${journalInputOrder(state).cardVersion(state)}:${this.legacy.key()}`
  }

  list(): readonly QueuedMessageRow[] {
    const key = this.revision()
    if (this.viewed?.key !== key) {
      const state = this.inputState()
      const cards = [...journalInputOrder(state).liveCards(state)]
      this.viewed = { key, cards: cards.sort((a, b) => a.position - b.position) }
    }
    return this.viewed.cards
  }

  attemptEnded(clientMessageId: string): boolean {
    const state = this.deps.state()
    const send = state.submissions.get(clientMessageId)
    return send !== undefined && journalInputAttemptEnded(state, send, this.inputWork())
  }

  get(messageId: string): QueuedMessageRow | null {
    return this.deps.state().queue.cards.get(messageId) ?? this.legacy.get(messageId) ?? null
  }

  /** Mail the orchestration owner cannot confirm now; the host installs it once, so every reader of
   *  the next card (drain, consume, publication, scheduling) applies one rule. */
  mailUnavailable: ((card: QueuedMessageRow) => boolean) | undefined

  /** Selection reads identity summaries; current values are resolved after edits. */
  nextInputCard(automatic = true): QueuedMessageRow | null {
    return nextEligibleQueuedCard({
      state: this.inputState(),
      floor: this.deps.reopenFloor(),
      get: (messageId) => this.get(messageId),
      editHeld: (messageId) => automatic && this.editLeases.isHeld(messageId),
      revisions: [this.revision(), automatic ? this.editLeases.version() : -1],
      unavailable: this.mailUnavailable
    })
  }

  // Card insertion, attachment claims and send receipt must commit together.
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
    const claims = journalAttachmentClaimReceipt((db) =>
      this.deps.claimAttachments(db, body, input.requireAttachments === true)
    )
    return this.write(
      () => {
        // Existing IDs are duplicate admission of the same accepted card, never new queue work.
        if (this.get(messageId)) {
          return { changes: [], result: undefined }
        }
        const { epoch, lastSequence } = this.deps.state()
        const position = journalInputOrder(this.inputState()).cardBounds(this.deps.state()).last + 1
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

  /** Edits invalidate old leases; require only newly referenced uploads so swept images cannot block text fixes. */
  update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    let edit: { body: AgentJournalMessageItem; previous: AgentJournalMessageItem } | undefined
    const receipt = journalAttachmentClaimReceipt(
      (db) => (edit ? this.deps.claimAttachments(db, edit.body, true, edit.previous) : undefined),
      () => this.editLeases.retire(input.messageId)
    )
    return this.write<AgentSessionQueuedMessageUpdateResult>(() => {
      edit = undefined
      const card = this.get(input.messageId)
      const decision = queuedMessageUpdateDecision(card, this.deps.sessionId, input)
      if (decision.status !== 'ready') {
        return { changes: [], result: decision }
      }
      edit = { body: decision.body, previous: decision.previous }
      const { messageId } = input
      return {
        changes: [
          {
            messageId,
            change: { op: 'edited', body: decision.body }
          }
        ],
        result: { status: 'updated', messageId, fingerprint: decision.fingerprint }
      }
    }, receipt)
  }

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

  withdraw(
    messageIds: readonly string[],
    receipt?: JournalOperationReceipt
  ): Promise<QueuedMessageRow[]> {
    if (messageIds.length === 0) {
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

  move(
    input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor,
    receipt?: JournalOperationReceipt
  ): Promise<AgentSessionQueuedMessageMoveResult> {
    return this.write(() => queuedMessageMovePlan(this.list(), input), receipt)
  }

  /** Adopt each selected legacy witness with its action; deletion is optional cleanup after commit. */
  plan(changes: readonly JournalQueueCardChange[]): JournalQueuePlan {
    return journalQueueAdoptionPlan(this.deps, this.legacy, changes)
  }

  /** Validate the acted-on card on the lane; automatic drain must still own the next queued card. */
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
      const next = this.nextInputCard()
      if (next?.messageId === input.messageId) {
        return
      }
    } else if (consumable) {
      return
    }
    throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
  }

  proofWitness(clientMessageId: string): JournalQueuePlan {
    const witness = this.legacy.witness(clientMessageId)
    return this.plan(witness ? [{ messageId: witness.messageId }] : [])
  }

  importAtOpen(): Promise<void> {
    return this.legacy.importAtOpen()
  }

  pauses(): DerivedQueuePause[] {
    return this.derivePauses(this.list())
  }

  awaitReopenMark(): boolean {
    if (this.list().some((card) => card.state === 'waiting')) {
      return true
    }
    const state = this.inputState()
    return journalInputOrder(state)
      .recoverableSubmissions()
      .some((entry) => {
        const card = entry.queuedMessageId ? this.get(entry.queuedMessageId) : null
        return (
          card?.state === 'dispatched' &&
          card.consumedAs === entry.clientMessageId &&
          (entry.dispatchState === 'pending' ||
            (entry.dispatchState === 'unknown' && entry.recovered !== true))
        )
      })
  }

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
      failedAt: journalInputOrder(state).newestTurn.failure(),
      cards,
      reopenFloor: this.deps.reopenFloor()
    })
  }

  /** Resolve after preceding writes; commit receipts with changed rows and skip empty plans. */
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
