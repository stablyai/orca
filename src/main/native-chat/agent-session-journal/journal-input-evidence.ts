import type { JournalKeyedMap } from './journal-keyed-storage'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  refusedBeforeWrite,
  stoppedHistoryCandidate
} from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import { classifyDispatchRejection } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalInputPlaceStorage, JournalIndexStorageFactory } from './journal-index-storage'
import { JournalInputObservations } from './journal-input-observations'
import { JournalSubmissionLinks } from './journal-submission-links'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'

/** Reconstructible query evidence on the input owner; canonical records remain authoritative. */
export class JournalInputEvidence extends JournalInputObservations {
  readonly links = new JournalSubmissionLinks()
  private readonly recoverable = new Map<string, AgentJournalSubmission>()
  private readonly nonRefused: JournalInputPlaceStorage
  private readonly submissionRows: JournalKeyedMap<number, string> = new Map()
  private readonly rowsBySubmission: JournalKeyedMap<string, number> = new Map()
  private readonly keptCards: JournalKeyedMap<string, Set<string>> = new Map()
  private readonly keptBySubmission: JournalKeyedMap<string, string> = new Map()
  private readonly ordinals: JournalKeyedMap<string, number> = new Map()
  private nextOrdinal = 0
  private readonly acceptedByTime: JournalInputPlaceStorage
  private readonly failedRequests: JournalInputPlaceStorage
  private readonly statusPending = new Map<string, AgentJournalSubmission>()
  private readonly steers = new Map<string, JournalInputPlaceStorage>()
  private readonly steerTurns: JournalKeyedMap<string, string> = new Map()
  private readonly stoppedCandidates = new Set<string>()
  private readonly stoppedOwed: JournalInputPlaceStorage
  private readonly carrierCoverage: JournalKeyedMap<string, readonly string[]> = new Map()
  private readonly coveredBy: JournalKeyedMap<string, Set<string>> = new Map()

  constructor(
    state: JournalReducerState,
    indexes: JournalIndexStorageFactory = memoryJournalIndexStorage
  ) {
    super(state, indexes)
    this.nonRefused = indexes.place('non-refused-inputs')
    this.acceptedByTime = indexes.place('accepted-by-time')
    this.failedRequests = indexes.place('failed-requests')
    this.stoppedOwed = indexes.place('stopped-owed')
  }

  refreshLink(id: string): void {
    this.links.refreshInput(this.state, id)
  }
  familyOriginal(id: string): AgentJournalSubmission | undefined {
    return this.links.original(id)
  }

  linkedVersion(): number {
    return this.links.version()
  }
  linkedTo(id: string): Iterable<AgentJournalSubmission> {
    return this.links.to(id)
  }
  recoverableSubmissions(): AgentJournalSubmission[] {
    return [...this.recoverable.values()].sort(
      (a, b) => this.inputOrdinal(a.clientMessageId) - this.inputOrdinal(b.clientMessageId)
    )
  }
  sentAfter(sequence: number): boolean {
    return this.nonRefused.allPlaces().position > sequence
  }
  submissionAt(sequence: number): AgentJournalSubmission | undefined {
    const id = this.submissionRows.get(sequence)
    return id === undefined ? undefined : this.state.submissions.get(id)
  }
  keptCard(id: string): boolean {
    return this.keptCards.has(id)
  }

  inputForItem(itemId: string): AgentJournalSubmission | undefined {
    const id = this.inputIds.get(itemId)
    return id === undefined ? undefined : this.state.submissions.get(id)
  }

  inputCount(): number {
    return this.nextOrdinal
  }

  inputOrdinal(id: string): number {
    return this.ordinals.get(id) ?? Infinity
  }

  /** Private evidence for the unchanged status helpers; transport snapshots retain all inputs. */
  statusInputs(
    state: JournalReducerState,
    items: readonly AgentJournalRenderItem[],
    afterStop?: number
  ): AgentJournalSubmission[] {
    const ids = new Set<string>(this.statusPending.keys())
    const add = (id: string | undefined) => {
      if (id !== undefined) {
        ids.add(id)
      }
    }
    add(this.acceptedByTime.lastId())
    add(this.failedRequests.lastId())
    if (afterStop !== undefined) {
      add(this.nonRefused.successorId(afterStop))
    }
    for (const item of items) {
      add(this.inputIds.get(item.itemId))
      // One latest steer preserves existence across the helper's actual clear-divider filter.
      add(this.steers.get(item.itemId)?.lastId())
    }
    return [...ids]
      .flatMap((id) => {
        const entry = state.submissions.get(id)
        return entry ? [entry] : []
      })
      .sort(
        (a, b) =>
          a.submittedAt - b.submittedAt ||
          this.inputOrdinal(a.clientMessageId) - this.inputOrdinal(b.clientMessageId)
      )
  }

  stoppedHistoryInputs(excluding: string, afterSequence = 0): AgentJournalSubmission[] {
    const ids = new Set(this.stoppedOwed.idsAfter(afterSequence))
    for (const id of this.carrierCoverage.get(excluding) ?? []) {
      const covers = this.coveredBy.get(id)
      if (
        this.stoppedCandidates.has(id) &&
        covers?.size === 1 &&
        covers.has(excluding) &&
        this.state.submissions.get(id)!.acceptedSequence! > afterSequence
      ) {
        ids.add(id)
      }
    }
    return [...ids]
      .flatMap((id) => {
        const input = this.state.submissions.get(id)
        return input ? [input] : []
      })
      .sort((a, b) => this.inputOrdinal(a.clientMessageId) - this.inputOrdinal(b.clientMessageId))
  }

  protected refreshInputEvidence(
    state: JournalReducerState,
    id: string,
    entry: AgentJournalSubmission | undefined
  ): void {
    if (entry && !this.ordinals.has(id)) {
      this.ordinals.set(id, this.nextOrdinal++)
    }
    this.refreshStopped(state, id, entry)
    if (
      entry &&
      (entry.dispatchState === 'pending' ||
        (entry.dispatchState === 'unknown' && entry.recovered !== true))
    ) {
      this.recoverable.set(id, entry)
    } else {
      this.recoverable.delete(id)
    }
    const ordinal = this.inputOrdinal(id)
    this.refreshObservations(id, entry, ordinal)
    if (entry) {
      this.inputIds.set(agentJournalSubmissionKey(id), id)
    } else {
      this.inputIds.delete(agentJournalSubmissionKey(id))
      this.ordinals.delete(id)
    }
    if (entry?.dispatchState === 'accepted') {
      this.acceptedByTime.setPosition(id, entry.submittedAt, ordinal)
    } else {
      this.acceptedByTime.delete(id)
    }
    if (
      entry?.dispatchState === 'rejected' &&
      classifyDispatchRejection(entry).verdict === 'failure'
    ) {
      this.failedRequests.setPosition(id, entry.acceptedSequence ?? 0, ordinal)
    } else {
      this.failedRequests.delete(id)
    }
    if (
      entry &&
      (entry.dispatchState === 'pending' ||
        (entry.dispatchState === 'unknown' &&
          entry.recovered !== true &&
          entry.reason !== 'host_restarted_before_acknowledgement'))
    ) {
      this.statusPending.set(id, entry)
    } else {
      this.statusPending.delete(id)
    }
    const turn =
      entry?.answeredInTurn?.via === 'steer' ? entry.answeredInTurn.turnItemId : undefined
    const oldTurn = this.steerTurns.get(id)
    if (oldTurn && oldTurn !== turn) {
      const index = this.steers.get(oldTurn)!
      index.delete(id)
      if (index.isEmpty()) {
        this.steers.delete(oldTurn)
      }
      this.steerTurns.delete(id)
    }
    if (turn && entry) {
      const index = this.steers.get(turn) ?? this.indexes.place('steers', turn)
      index.setPosition(id, entry.acceptedSequence ?? 0, ordinal)
      this.steers.set(turn, index)
      this.steerTurns.set(id, turn)
    }
    const oldSequence = this.rowsBySubmission.get(id)
    if (oldSequence !== entry?.submittedSequence && oldSequence !== undefined) {
      this.submissionRows.delete(oldSequence)
      this.rowsBySubmission.delete(id)
    }
    if (entry?.submittedSequence !== undefined) {
      this.submissionRows.set(entry.submittedSequence, id)
      this.rowsBySubmission.set(id, entry.submittedSequence)
    }
    if (entry?.dispatchState !== 'rejected' && entry?.acceptedSequence !== undefined) {
      this.nonRefused.setPosition(id, entry.acceptedSequence)
    } else {
      this.nonRefused.delete(id)
    }
    const oldKept = this.keptBySubmission.get(id)
    if (oldKept !== entry?.keptAsQueuedMessageId) {
      if (oldKept) {
        const members = this.keptCards.get(oldKept)!
        members.delete(id)
        if (members.size === 0) {
          this.keptCards.delete(oldKept)
        }
        this.keptBySubmission.delete(id)
      }
      if (entry?.keptAsQueuedMessageId) {
        const members = this.keptCards.get(entry.keptAsQueuedMessageId) ?? new Set<string>()
        members.add(id)
        this.keptCards.set(entry.keptAsQueuedMessageId, members)
        this.keptBySubmission.set(id, entry.keptAsQueuedMessageId)
      }
    }
  }

  private refreshStopped(
    state: JournalReducerState,
    id: string,
    entry: AgentJournalSubmission | undefined
  ): void {
    if (entry && stoppedHistoryCandidate(entry)) {
      this.stoppedCandidates.add(id)
    } else {
      this.stoppedCandidates.delete(id)
    }
    const affected = new Set<string>([id])
    for (const carried of this.carrierCoverage.get(id) ?? []) {
      const covers = this.coveredBy.get(carried)!
      covers.delete(id)
      if (!covers.size) {
        this.coveredBy.delete(carried)
      }
      affected.add(carried)
    }
    this.carrierCoverage.delete(id)
    const carried =
      entry && !refusedBeforeWrite(entry) ? state.stoppedHistoryCarried.get(id) : undefined
    if (carried) {
      this.carrierCoverage.set(id, carried)
      for (const original of carried) {
        const covers = this.coveredBy.get(original) ?? new Set<string>()
        covers.add(id)
        this.coveredBy.set(original, covers)
        affected.add(original)
      }
    }
    for (const original of affected) {
      if (this.stoppedCandidates.has(original) && !this.coveredBy.has(original)) {
        this.stoppedOwed.setPosition(
          original,
          state.submissions.get(original)!.acceptedSequence!,
          this.inputOrdinal(original)
        )
      } else {
        this.stoppedOwed.delete(original)
      }
    }
  }
}
