import type { JournalInputEvidenceFacts } from '../journal-input-facts-storage'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  refusedBeforeWrite,
  stoppedHistoryCandidate
} from '../../../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import { classifyDispatchRejection } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalInputPlaceStorage, JournalInputIndexStorage } from '../journal-index-storage'
import { JournalInputObservations } from './journal-input-observations'
import { journalSubmissionIsPersonal } from '../submissions/journal-submission-fold'
import { JournalSubmissionLinks } from './journal-submission-links'
import { memoryJournalInputIndexStorage } from '../journal-memory-input-index-storage'

/** Reconstructible query evidence on the input owner; canonical records remain authoritative. */
export class JournalInputEvidence extends JournalInputObservations {
  readonly links: JournalSubmissionLinks
  private readonly evidenceFacts: JournalInputEvidenceFacts
  private readonly nonRefused: JournalInputPlaceStorage
  private readonly acceptedByTime: JournalInputPlaceStorage
  private readonly failedRequests: JournalInputPlaceStorage
  private readonly stoppedOwed: JournalInputPlaceStorage

  constructor(
    state: JournalReducerState,
    indexes: JournalInputIndexStorage = memoryJournalInputIndexStorage
  ) {
    super(state, indexes)
    this.evidenceFacts = indexes.evidenceFacts()
    this.links = new JournalSubmissionLinks(indexes)
    this.nonRefused = indexes.place('non-refused-inputs')
    this.acceptedByTime = indexes.place('accepted-by-time')
    this.failedRequests = indexes.place('failed-requests')
    this.stoppedOwed = indexes.place('stopped-owed')
  }

  latestPersonAcceptedSequence(): number {
    return this.evidenceFacts.personAcceptedSequence
  }
  seedPersonAcceptance(sequence: number): void {
    this.evidenceFacts.personAcceptedSequence = Math.max(
      this.evidenceFacts.personAcceptedSequence,
      sequence
    )
  }
  personalSubmission(
    submission: Pick<AgentJournalSubmission, 'queuedMessageId' | 'source' | 'origin'>
  ): boolean {
    return journalSubmissionIsPersonal(this.state, submission)
  }
  notePersonAcceptance(
    submission: Pick<
      AgentJournalSubmission,
      'acceptedSequence' | 'queuedMessageId' | 'source' | 'origin'
    >
  ): void {
    if (this.personalSubmission(submission)) {
      this.seedPersonAcceptance(submission.acceptedSequence ?? 0)
    }
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
    return [...this.evidenceFacts.recoverableSubmissions()].sort(
      (a, b) => this.inputOrdinal(a.clientMessageId) - this.inputOrdinal(b.clientMessageId)
    )
  }
  sentAfter(sequence: number): boolean {
    return this.nonRefused.allPlaces().position > sequence
  }
  submissionAt(sequence: number): AgentJournalSubmission | undefined {
    const id = this.evidenceFacts.submissionRows.get(sequence)
    return id === undefined ? undefined : this.state.submissions.get(id)
  }
  keptCard(id: string): boolean {
    return this.evidenceFacts.keptCards.has(id)
  }

  inputForItem(itemId: string): AgentJournalSubmission | undefined {
    const id = this.observationFacts.inputIds.get(itemId)
    return id === undefined ? undefined : this.state.submissions.get(id)
  }

  inputCount(): number {
    return this.evidenceFacts.nextOrdinal
  }

  inputOrdinal(id: string): number {
    return this.evidenceFacts.ordinals.get(id) ?? Infinity
  }

  latestSteerForItem = (itemId: string) => this.evidenceFacts.steers.get(itemId)?.lastId()

  /** Private evidence for the unchanged status helpers; transport snapshots retain all inputs. */
  statusInputs(
    state: JournalReducerState,
    items: readonly AgentJournalRenderItem[],
    afterStop?: number
  ): AgentJournalSubmission[] {
    const ids = new Set<string>(this.evidenceFacts.statusPendingIds())
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
      add(this.observationFacts.inputIds.get(item.itemId))
      // One latest steer preserves existence across the helper's actual clear-divider filter.
      add(this.evidenceFacts.steers.get(item.itemId)?.lastId())
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
    for (const id of this.evidenceFacts.carrierCoverage.get(excluding) ?? []) {
      const covers = this.evidenceFacts.coveredBy.get(id)
      if (
        this.evidenceFacts.stoppedCandidates.has(id) &&
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
    if (entry && !this.evidenceFacts.ordinals.has(id)) {
      this.evidenceFacts.ordinals.set(id, this.evidenceFacts.nextOrdinal++)
    }
    this.refreshStopped(state, id, entry)
    if (
      entry &&
      (entry.dispatchState === 'pending' ||
        (entry.dispatchState === 'unknown' && entry.recovered !== true))
    ) {
      this.evidenceFacts.recoverable.set(id, entry)
    } else {
      this.evidenceFacts.recoverable.delete(id)
    }
    const ordinal = this.inputOrdinal(id)
    this.refreshObservations(id, entry, ordinal)
    if (entry) {
      this.observationFacts.inputIds.set(agentJournalSubmissionKey(id), id)
    } else {
      this.observationFacts.inputIds.delete(agentJournalSubmissionKey(id))
      this.evidenceFacts.ordinals.delete(id)
    }
    if (entry?.dispatchState === 'accepted') {
      this.notePersonAcceptance(entry)
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
      this.evidenceFacts.statusPending.set(id, entry)
    } else {
      this.evidenceFacts.statusPending.delete(id)
    }
    const turn =
      entry?.answeredInTurn?.via === 'steer' ? entry.answeredInTurn.turnItemId : undefined
    const oldTurn = this.evidenceFacts.steerTurns.get(id)
    if (oldTurn && oldTurn !== turn) {
      const index = this.evidenceFacts.steers.get(oldTurn)!
      index.delete(id)
      if (index.isEmpty()) {
        this.evidenceFacts.steers.delete(oldTurn)
      }
      this.evidenceFacts.steerTurns.delete(id)
    }
    if (turn && entry) {
      const index = this.evidenceFacts.steers.get(turn) ?? this.indexes.place('steers', turn)
      index.setPosition(id, entry.acceptedSequence ?? 0, ordinal)
      this.evidenceFacts.steers.set(turn, index)
      this.evidenceFacts.steerTurns.set(id, turn)
    }
    const oldSequence = this.evidenceFacts.rowsBySubmission.get(id)
    if (oldSequence !== entry?.submittedSequence && oldSequence !== undefined) {
      this.evidenceFacts.submissionRows.delete(oldSequence)
      this.evidenceFacts.rowsBySubmission.delete(id)
    }
    if (entry?.submittedSequence !== undefined) {
      this.evidenceFacts.submissionRows.set(entry.submittedSequence, id)
      this.evidenceFacts.rowsBySubmission.set(id, entry.submittedSequence)
    }
    if (entry?.dispatchState !== 'rejected' && entry?.acceptedSequence !== undefined) {
      this.nonRefused.setPosition(id, entry.acceptedSequence)
    } else {
      this.nonRefused.delete(id)
    }
    const oldKept = this.evidenceFacts.keptBySubmission.get(id)
    if (oldKept !== entry?.keptAsQueuedMessageId) {
      if (oldKept) {
        const members = this.evidenceFacts.keptCards.get(oldKept)!
        members.delete(id)
        if (members.size === 0) {
          this.evidenceFacts.keptCards.delete(oldKept)
        }
        this.evidenceFacts.keptBySubmission.delete(id)
      }
      if (entry?.keptAsQueuedMessageId) {
        const members =
          this.evidenceFacts.keptCards.get(entry.keptAsQueuedMessageId) ??
          this.indexes.set<string>('kept-card-members', entry.keptAsQueuedMessageId)
        members.add(id)
        this.evidenceFacts.keptCards.set(entry.keptAsQueuedMessageId, members)
        this.evidenceFacts.keptBySubmission.set(id, entry.keptAsQueuedMessageId)
      }
    }
  }

  private refreshStopped(
    state: JournalReducerState,
    id: string,
    entry: AgentJournalSubmission | undefined
  ): void {
    if (entry && stoppedHistoryCandidate(entry)) {
      this.evidenceFacts.stoppedCandidates.add(id)
    } else {
      this.evidenceFacts.stoppedCandidates.delete(id)
    }
    const affected = new Set<string>([id])
    for (const carried of this.evidenceFacts.carrierCoverage.get(id) ?? []) {
      const covers = this.evidenceFacts.coveredBy.get(carried)!
      covers.delete(id)
      if (!covers.size) {
        this.evidenceFacts.coveredBy.delete(carried)
      }
      affected.add(carried)
    }
    this.evidenceFacts.carrierCoverage.delete(id)
    const carried =
      entry && !refusedBeforeWrite(entry) ? state.stoppedHistoryCarried.get(id) : undefined
    if (carried) {
      this.evidenceFacts.carrierCoverage.set(id, carried)
      for (const original of carried) {
        const covers =
          this.evidenceFacts.coveredBy.get(original) ??
          this.indexes.set<string>('carrier-coverers', original)
        covers.add(id)
        this.evidenceFacts.coveredBy.set(original, covers)
        affected.add(original)
      }
    }
    for (const original of affected) {
      if (
        this.evidenceFacts.stoppedCandidates.has(original) &&
        !this.evidenceFacts.coveredBy.has(original)
      ) {
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
