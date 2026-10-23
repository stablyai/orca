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

/** Card rows to write in one transaction, with what must commit beside them. */
export type JournalQueuePlan = {
  rows: ((seq: number, ts: number) => JournalQueueRow)[]
  receipt: JournalOperationReceipt
}

/** What a new epoch writes again of the queue (`retainedQueueFacts`). */
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

  /** Moves with every card change, so publication memos recompute only when they must. */
  revision(): string {
    const { epoch, queue } = this.deps.state()
    return `${epoch}:${queue.revision}:${this.legacy.key()}`
  }

  /** The cards every reader sees, in queue order: the fold's, and any an earlier build wrote that
   *  are not in the journal yet (`journal-queue-import.ts`). */
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

  /** On the journal's lane: rows for these changes, each card an earlier build wrote moved into the
   *  journal first, its legacy row deleted in the same transaction (`journal-queue-import.ts`). */
  plan(changes: readonly JournalQueueCardChange[]): JournalQueuePlan {
    const rows: JournalQueuePlan['rows'] = []
    const adopted: string[] = []
    for (const { messageId, change } of changes) {
      const own = this.deps.state().queue.cards.has(messageId) || adopted.includes(messageId)
      const adoption = own ? null : this.legacy.adoption(messageId)
      if (adoption) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, adoption))
        adopted.push(messageId)
      }
      if (change) {
        rows.push(journalQueueRowBuilder(this.deps.state, messageId, change))
      }
    }
    return { rows, receipt: this.legacy.deletion(adopted) }
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

  /** What a new epoch restates, with every legacy card: their rows go in the same transaction. */
  restatement(): JournalQueueRestatement {
    return {
      cards: retainedQueueFacts(this.list(), this.deps.state().submissions),
      receipt: this.legacy.deletionOfAll()
    }
  }

  /** Every legacy card moved into the journal, every legacy row deleted, with a write that retires
   *  hand-offs: each card's reading is then latched in the fold before its hand-off is gone. */
  adoptionOfAll(): JournalQueuePlan {
    const { rows } = this.plan(this.legacy.messageIds().map((messageId) => ({ messageId })))
    return { rows, receipt: this.legacy.deletionOfAll() }
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
    const { submissions } = this.deps.state()
    return this.list().some((card) => {
      if (card.state === 'waiting') {
        return true
      }
      const handOff = card.consumedAs ? submissions.get(card.consumedAs) : undefined
      // A recovered doubt outlived its writer: nothing brings that card back to waiting.
      return (
        card.state === 'dispatched' &&
        (handOff?.dispatchState === 'pending' ||
          (handOff?.dispatchState === 'unknown' && handOff.recovered !== true))
      )
    })
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
