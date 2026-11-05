import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { JournalReducerState } from './journal-reducer'
import { JournalInputPlaceIndex } from './journal-input-place-index'

export type JournalInputKeys = {
  has: (key: string) => boolean
  present: ReadonlySet<string>
  changes: ReadonlyMap<string, boolean>
  same: (other: JournalInputKeys) => boolean
}

type CaptureOwner = {
  current: JournalInputObservations
  preparing?: JournalInputObservations
  replacementChanges?: Map<string, boolean>
}
const captureOwners = new WeakMap<JournalInputObservations, CaptureOwner>()
function captureOwner(owner: JournalInputObservations): CaptureOwner {
  let registered = captureOwners.get(owner)
  if (!registered) {
    registered = { current: owner }
    captureOwners.set(owner, registered)
  }
  return registered
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
    let changes = new Map<string, boolean>()
    const token = Symbol()
    const owner = captureOwner(this)
    owner.current.keyReads.set(token, changes)
    if (owner.preparing && owner.replacementChanges) {
      owner.preparing.keyReads.set(token, owner.replacementChanges)
    }
    const currentChanges = () => {
      changes = owner.current.keyReads.get(token) ?? changes
      return changes
    }
    const close = () => {
      currentChanges()
      owner.current.keyReads.delete(token)
      owner.preparing?.keyReads.delete(token)
    }
    signal.addEventListener('abort', close, { once: true })
    if (signal.aborted) {
      close()
    }
    const has = (key: string) =>
      present.has(key) || (currentChanges().get(key) ?? owner.current.inputIds.has(key))
    return {
      has,
      present,
      get changes() {
        return currentChanges()
      },
      same(other) {
        const keys = new Set([
          ...present,
          ...other.present,
          ...currentChanges().keys(),
          ...other.changes.keys()
        ])
        return [...keys].every((key) => has(key) === other.has(key))
      }
    }
  }

  /** New captures during the reservation all see the same old committed membership. */
  *prepareReplacementCapturesSteps(previous: JournalInputObservations): Generator<void> {
    const owner = captureOwner(previous)
    const live = owner.current
    const changed = new Map<string, boolean>()
    for (const key of live.inputIds.keys()) {
      if (!this.inputIds.has(key)) {
        changed.set(key, true)
      }
      yield
    }
    for (const key of this.inputIds.keys()) {
      if (!live.inputIds.has(key)) {
        changed.set(key, false)
      }
      yield
    }
    owner.preparing = this
    owner.replacementChanges = changed
    captureOwners.set(this, owner)
    for (const token of this.keyReads.keys()) {
      if (!live.keyReads.has(token)) {
        this.keyReads.delete(token)
      }
      yield
    }
    for (const [token, prior] of live.keyReads) {
      let next = this.keyReads.get(token)
      if (!next) {
        next = changed
        this.keyReads.set(token, next)
      }
      for (const [key, value] of prior) {
        if (!next.has(key)) {
          next.set(key, value)
        }
        yield
      }
      for (const [key, value] of changed) {
        if (!next.has(key)) {
          next.set(key, value)
        }
        yield
      }
    }
  }

  releaseReplacementCaptures(): void {
    const owner = captureOwner(this)
    if (owner.preparing === this) {
      owner.preparing = undefined
      owner.replacementChanges = undefined
    }
  }

  publishReplacementCaptures(): void {
    const owner = captureOwner(this)
    owner.current = this
    owner.preparing = undefined
    owner.replacementChanges = undefined
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
