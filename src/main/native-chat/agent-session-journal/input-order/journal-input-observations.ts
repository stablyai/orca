import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readWholeAgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { JournalReducerState } from '../projection/journal-reducer'
import { JournalInputPlaceIndex } from './journal-input-place-index'

export type JournalInputKeys = {
  has: (key: string) => boolean
  present: ReadonlySet<string>
  changes: ReadonlyMap<string, boolean>
  same: (other: JournalInputKeys) => boolean
}

/** Derived named lifecycle queries on the input owner, refreshed in its isolated draft. */
export abstract class JournalInputObservations {
  private readonly keyReads = new Map<symbol, Map<string, boolean>>()
  private readonly submittedByFence = new JournalInputPlaceIndex('')
  private readonly acceptedByFence = new JournalInputPlaceIndex('')
  private readonly providerInputs = new Map<string, JournalInputPlaceIndex>()
  private readonly providerByInput = new Map<string, string>()
  private readonly receiptSequences = new JournalInputPlaceIndex('')
  protected readonly inputIds = new Map<string, string>()
  private readonly dispatchByFence = new Map<number, JournalInputPlaceIndex>()
  private readonly signedOutByFence = new Map<number, Set<string>>()
  private readonly fences = new Map<string, number>()
  private readonly recoveredUnknown = new Set<string>()
  private readonly accepted = new JournalInputPlaceIndex('')

  constructor(protected readonly state: JournalReducerState) {}

  hasInputs(): boolean {
    return this.state.submissions.size !== 0
  }

  /** A finite catch-up owns only keys changed while it awaits provider history. */
  captureKeys(present: ReadonlySet<string>, signal: AbortSignal): JournalInputKeys {
    const changes = new Map<string, boolean>()
    const token = Symbol()
    this.keyReads.set(token, changes)
    signal.addEventListener('abort', () => this.keyReads.delete(token), { once: true })
    if (signal.aborted) {
      this.keyReads.delete(token)
    }
    const has = (key: string) => present.has(key) || (changes.get(key) ?? this.inputIds.has(key))
    return {
      has,
      present,
      changes,
      same(other) {
        const keys = new Set([
          ...present,
          ...other.present,
          ...changes.keys(),
          ...other.changes.keys()
        ])
        return [...keys].every((key) => has(key) === other.has(key))
      }
    }
  }

  submissionExtremaAfterFence(afterFence: number): AgentJournalSubmission[] {
    return [
      ...new Set([
        this.submittedByFence.maximumAfter(afterFence),
        this.acceptedByFence.maximumAfter(afterFence)
      ])
    ].flatMap((id) => {
      const input = id === undefined ? undefined : this.state.submissions.get(id)
      return input ? [input] : []
    })
  }

  firstInputForProviderItem(key: string): AgentJournalSubmission | undefined {
    const id = this.providerInputs.get(key)?.successorId(-Infinity)
    return id === undefined ? undefined : this.state.submissions.get(id)
  }

  latestReceiptSequence(): number {
    return Math.max(0, this.receiptSequences.allPlaces().position)
  }

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
  acceptedInputsAfter(sequence: number): AgentJournalSubmission[] {
    return this.accepted.idsAfter(sequence).flatMap((id) => {
      const input = this.state.submissions.get(id)
      return input ? [input] : []
    })
  }
  acceptedAfter(sequence: number): boolean {
    return this.accepted.allPlaces().position > sequence
  }

  protected refreshObservations(
    id: string,
    entry: AgentJournalSubmission | undefined,
    ordinal: number
  ): void {
    const receipt = entry && this.state.receipts.get(id)
    if (receipt) {
      this.receiptSequences.setPosition(id, receipt.cursor.sequence)
    } else {
      this.receiptSequences.delete(id)
    }
    if (entry) {
      this.submittedByFence.setSummary(id, entry.fence, entry.submittedAt, ordinal)
    } else {
      this.submittedByFence.delete(id)
    }
    if (entry?.dispatchState === 'accepted') {
      this.acceptedByFence.setSummary(id, entry.fence, entry.submittedAt, ordinal)
    } else {
      this.acceptedByFence.delete(id)
    }
    const oldProvider = this.providerByInput.get(id)
    if (oldProvider && oldProvider !== entry?.providerItemId) {
      const index = this.providerInputs.get(oldProvider)!
      index.delete(id)
      if (index.isEmpty()) {
        this.providerInputs.delete(oldProvider)
      }
      this.providerByInput.delete(id)
    }
    if (entry?.providerItemId) {
      const index = this.providerInputs.get(entry.providerItemId) ?? new JournalInputPlaceIndex('')
      index.setPosition(id, ordinal)
      this.providerInputs.set(entry.providerItemId, index)
      this.providerByInput.set(id, entry.providerItemId)
    }
    const key = agentJournalSubmissionKey(id)
    const existed = this.inputIds.has(key)
    if (existed !== (entry !== undefined)) {
      for (const read of this.keyReads.values()) {
        if (!read.has(key)) {
          read.set(key, existed)
        }
      }
    }
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
