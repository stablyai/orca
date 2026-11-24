// Host-private exact commands, keyed by the committed child record object in the authoritative
// status store. Generic records, snapshots, exports, views and replicas never carry them.

import {
  agentChildWorkFencesEqual,
  type AgentChildWorkRecord
} from '../../../../shared/agent-status/child-work/agent-status-child-work'
import { agentStatusSubjectsEqual } from '../../../../shared/agent-status/contracts/agent-status-subject'
import { randomUUID } from 'node:crypto'
import {
  createAgentStatusStore,
  type AgentStatusStore
} from '../../../../shared/agent-status/store/agent-status-store'
import type { AgentStatusStoreChildCommit } from '../../../../shared/agent-status/store/agent-status-store-commit'
import type { AgentChildWorkLiveAdmissionObserver } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence-admission'
import type { AgentChildWorkLiveObservation } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import {
  liveEvidenceOccurrence,
  type StructuredCommandOccurrence
} from './structured-command-occurrence'

export type StructuredCommandDetailSlot = {
  /** The provider-ownership fence the producing sink was bound to when the bytes were admitted. */
  fence: number
  occurrence: WeakRef<StructuredCommandOccurrence>
  display: string
}

/** What the trusted producer proved for one delivery: its bound, current acquisition fence. */
export type StructuredChildWorkAuthority = { fence: number }

/** Same parent, kind, provider, provenance and invocation: the replacement is the same command. */
function sameCommand(previous: AgentChildWorkRecord, next: AgentChildWorkRecord): boolean {
  return (
    previous.childWorkId === next.childWorkId &&
    previous.kind === next.kind &&
    previous.provider === next.provider &&
    previous.provenance.source === next.provenance.source &&
    previous.provenance.producerId === next.provenance.producerId &&
    agentStatusSubjectsEqual(previous.parent, next.parent) &&
    agentChildWorkFencesEqual(previous.invocation, next.invocation)
  )
}

export class StructuredCommandDetailSlots {
  private readonly slots = new WeakMap<AgentChildWorkRecord, StructuredCommandDetailSlot>()

  /** Store hook: runs inside the committing mutation, before it returns or publishes. */
  readonly committed = (changes: readonly AgentStatusStoreChildCommit[]): void => {
    for (const { previous, next, replaced } of changes) {
      const slot = previous ? this.slots.get(previous) : undefined
      if (previous) {
        this.slots.delete(previous)
      }
      if (slot && next && !replaced && sameCommand(previous!, next)) {
        this.slots.set(next, slot)
      }
    }
  }

  read(record: AgentChildWorkRecord): StructuredCommandDetailSlot | undefined {
    return this.slots.get(record)
  }

  has(record: AgentChildWorkRecord): boolean {
    return this.slots.has(record)
  }

  /** The admission observer for one trusted delivery. Without authority it can only revoke. */
  observer(
    readChild: (childWorkId: string) => AgentChildWorkRecord | null,
    authority: StructuredChildWorkAuthority | undefined
  ): AgentChildWorkLiveAdmissionObserver {
    const firstResolution = new WeakMap<AgentChildWorkLiveObservation, boolean>()
    return {
      resolved: (child, resolution) => {
        const occurrence = liveEvidenceOccurrence(child)
        firstResolution.set(
          child,
          !resolution.ambiguous && !resolution.existing && resolution.highestGeneration === null
        )
        // §P: only an unseen occurrence learns retirement; a seen one is resolving its own record.
        if (
          occurrence &&
          !occurrence.seen &&
          (resolution.ambiguous || resolution.existing || resolution.highestGeneration !== null)
        ) {
          occurrence.retirementObserved = true
        }
      },
      admitted: (child, childWorkId, created) => {
        const record = readChild(childWorkId)
        if (!record) {
          return
        }
        const occurrence = liveEvidenceOccurrence(child)
        const firstSeen = occurrence !== null && !occurrence.seen
        if (occurrence) {
          occurrence.seen = true
        }
        if (!created) {
          this.restated(record, occurrence, authority)
          return
        }
        if (
          record.kind === 'command' &&
          firstSeen &&
          occurrence.display !== null &&
          !occurrence.retirementObserved &&
          firstResolution.get(child) === true &&
          authority !== undefined
        ) {
          this.slots.set(record, {
            fence: authority.fence,
            occurrence: new WeakRef(occurrence),
            display: occurrence.display
          })
        }
      }
    }
  }

  /** A later accepted live update keeps the bytes only from the same occurrence and fence. */
  private restated(
    record: AgentChildWorkRecord,
    occurrence: StructuredCommandOccurrence | null,
    authority: StructuredChildWorkAuthority | undefined
  ): void {
    const slot = this.slots.get(record)
    if (
      slot &&
      (occurrence === null ||
        slot.occurrence.deref() !== occurrence ||
        authority === undefined ||
        authority.fence !== slot.fence)
    ) {
      this.slots.delete(record)
    }
  }
}

const slotsByStore = new WeakMap<AgentStatusStore, StructuredCommandDetailSlots>()

/** The host's authoritative status store, with exact-command slots bound to its commits. */
export function createCanonicalAgentStatusStore(): AgentStatusStore {
  const slots = new StructuredCommandDetailSlots()
  const store = createAgentStatusStore({
    epoch: randomUUID(),
    mode: 'authority',
    onChildrenCommitted: slots.committed
  })
  slotsByStore.set(store, slots)
  return store
}

/** Only the store created above has slots; any other store binds and reads nothing. */
export function commandDetailSlotsOf(store: AgentStatusStore): StructuredCommandDetailSlots {
  let slots = slotsByStore.get(store)
  if (!slots) {
    slots = new StructuredCommandDetailSlots()
    slotsByStore.set(store, slots)
  }
  return slots
}
