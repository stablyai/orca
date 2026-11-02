import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { JournalReducerState } from './journal-reducer'
import { JournalInputPlaceIndex } from './journal-input-place-index'

/** Derived named lifecycle queries on the input owner, refreshed in its isolated draft. */
export abstract class JournalInputObservations {
  private readonly dispatchByFence = new Map<number, JournalInputPlaceIndex>()
  private readonly signedOutByFence = new Map<number, Set<string>>()
  private readonly fences = new Map<string, number>()
  private readonly recoveredUnknown = new Set<string>()
  private readonly accepted = new JournalInputPlaceIndex('')

  constructor(protected readonly state: JournalReducerState) {}

  latestSubmission(fence: number): AgentJournalSubmission | undefined {
    const id = this.dispatchByFence.get(fence)?.lastId()
    return id === undefined ? undefined : this.state.submissions.get(id)
  }
  abstract inputOrdinal(id: string): number
  recoveredUnknownIds(): string[] {
    return [...this.recoveredUnknown].sort((a, b) => this.inputOrdinal(a) - this.inputOrdinal(b))
  }
  signedOutAt(fence: number): boolean {
    return (this.signedOutByFence.get(fence)?.size ?? 0) > 0
  }
  acceptedAfter(sequence: number): boolean {
    return this.accepted.allPlaces().position > sequence
  }

  protected refreshObservations(
    id: string,
    entry: AgentJournalSubmission | undefined,
    ordinal: number
  ): void {
    const prior = this.fences.get(id)
    if (prior !== undefined && prior !== entry?.fence) {
      const index = this.dispatchByFence.get(prior)!
      index.delete(id)
      if (index.isEmpty()) {
        this.dispatchByFence.delete(prior)
      }
      const signedOut = this.signedOutByFence.get(prior)
      signedOut?.delete(id)
      if (signedOut?.size === 0) {
        this.signedOutByFence.delete(prior)
      }
      this.fences.delete(id)
    }
    if (entry) {
      const index = this.dispatchByFence.get(entry.fence) ?? new JournalInputPlaceIndex('')
      index.setPosition(id, entry.submittedAt, ordinal)
      this.dispatchByFence.set(entry.fence, index)
      this.fences.set(id, entry.fence)
      const signedOut = this.signedOutByFence.get(entry.fence)
      if (
        entry.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(entry.rejection)?.kind === 'notSignedIn'
      ) {
        const members = this.signedOutByFence.get(entry.fence) ?? new Set<string>()
        members.add(id)
        this.signedOutByFence.set(entry.fence, members)
      } else if (signedOut) {
        signedOut.delete(id)
        if (signedOut.size === 0) {
          this.signedOutByFence.delete(entry.fence)
        }
      }
    }
    if (entry?.dispatchState === 'unknown' && entry.recovered === true) {
      this.recoveredUnknown.add(id)
    } else {
      this.recoveredUnknown.delete(id)
    }
    if (entry?.acceptedSequence !== undefined) {
      this.accepted.setPosition(id, entry.acceptedSequence)
    } else {
      this.accepted.delete(id)
    }
  }
}
