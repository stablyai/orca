import { journalQueueAdoptionPlan } from './journal-queue-adoption-plan'
import {
  journalAttachmentClaimReceipt,
  journalAttachmentClaimsReceipt
} from './journal-submission-hook'
// Fold cards from journal rows, without a second mutable copy. Drafts never count as active work.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { JournalQueueCardChange, JournalQueueRow } from './journal-queue-events'
import { LegacyQueuedCards } from './journal-queue-import'
import { retainedQueueFacts } from './journal-queue-retention'
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
import type { JournalReducerState } from './journal-reducer'
import { queuedMessageMovePlan } from './queued-message-move'

export type JournalQueuePlan = {
  rows: ((seq: number, ts: number) => JournalQueueRow)[]
  receipt: JournalOperationReceipt
}

export type JournalQueueRestatement = {
  cards: readonly JournalQueueCardChange[]
  receipt: JournalOperationReceipt
}

export class JournalQueuedMessages {
  readonly editLeases = new QueuedMessageEditLeases(() => this.list())
  private readonly legacy: LegacyQueuedCards
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: JournalQueuedMessagesDeps) {
    this.legacy = new LegacyQueuedCards(deps)
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  displayState(): JournalReducerState {
    return this.legacy.displayState()
  }

  revision(): string {
    const { epoch, queue } = this.deps.state()
    return `${epoch}:${queue.revision}:${this.legacy.key()}`
  }

  list(): readonly QueuedMessageRow[] {
    const key = this.revision()
    if (this.viewed?.key !== key) {
      const cards = [...this.deps.state().queue.cards.values(), ...this.legacy.cards()]
      this.viewed = { key, cards: cards.sort((a, b) => a.position - b.position) }
    }
    return this.viewed.cards
  }

  get(messageId: string): QueuedMessageRow | null {
    return (
      this.deps.state().queue.cards.get(messageId) ??
      this.legacy.cards().find((card) => card.messageId === messageId) ??
      null
    )
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

  /** Edits invalidate old leases; require only newly referenced uploads so swept images cannot block text fixes. */
  update(input: QueuedMessageUpdate): Promise<AgentSessionQueuedMessageUpdateResult> {
    let edit: { body: AgentJournalMessageItem; previous: AgentJournalMessageItem } | undefined
    const receipt = journalAttachmentClaimReceipt(
      (db) => (edit ? this.deps.claimAttachments(db, edit.body, true, edit.previous) : undefined),
      () => this.editLeases.retire(input.messageId)
    )
    return this.write<AgentSessionQueuedMessageUpdateResult>(() => {
      edit = undefined
      const decision = queuedMessageUpdateDecision(
        this.get(input.messageId),
        this.deps.sessionId,
        input
      )
      if (decision.status !== 'ready') {
        return { changes: [], result: decision }
      }
      edit = { body: decision.body, previous: decision.previous }
      const { messageId } = input
      return {
        changes: [{ messageId, change: { op: 'edited', body: decision.body } }],
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

  /** Plan on the journal lane; adopt/delete legacy cards in the same transaction before changing them. */
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

  restatement(): JournalQueueRestatement {
    const cards = retainedQueueFacts(this.list(), this.deps.state().submissions)
    return {
      cards,
      receipt: journalAttachmentClaimsReceipt(
        this.deps.claimAttachments,
        cards.flatMap(({ change }) => (change?.op === 'queued' ? [change.body] : [])),
        this.legacy.deletionOfAll()
      )
    }
  }

  /** Latch legacy card outcomes before retiring their handoff rows. */
  adoptionOfAll(): JournalQueuePlan {
    const { rows, receipt } = this.plan(
      this.legacy.messageIds().map((messageId) => ({ messageId }))
    )
    return { rows, receipt: composeJournalOperationReceipts(receipt, this.legacy.deletionOfAll()) }
  }

  importAtOpen(): Promise<void> {
    return this.legacy.importAtOpen()
  }

  pauses(): DerivedQueuePause[] {
    return this.derivePauses(this.list())
  }

  awaitReopenMark(): boolean {
    const { submissions } = this.deps.state()
    return this.list().some((card) => {
      if (card.state === 'waiting') {
        return true
      }
      const handOff = card.consumedAs ? submissions.get(card.consumedAs) : undefined
      // Recovered uncertainty cannot return a card to waiting.
      return (
        card.state === 'dispatched' &&
        (handOff?.dispatchState === 'pending' ||
          (handOff?.dispatchState === 'unknown' && handOff.recovered !== true))
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
