import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { memoryJournalMap, memoryJournalSet } from './journal-memory-collections'
import type {
  JournalInputOrderFacts,
  JournalInputCardFacts,
  JournalInputObservationFacts,
  JournalInputEvidenceFacts,
  JournalSubmissionLinkFacts
} from './journal-input-facts-storage'
import type { JournalKeyedMap } from './journal-keyed-storage'

export function memoryJournalInputOrderFacts(): JournalInputOrderFacts {
  const recoveryOwed = new Set<string>()
  const queued = new Map<string, AgentJournalSubmission>()
  const entered = new Map<string, AgentJournalSubmission>()
  return {
    recoveryOwed,
    queued,
    entered,
    firstQueued() {
      return memoryJournalMap(this.queued).values().next().value
    },
    enteredSubmissions() {
      return memoryJournalMap(this.entered).values()
    },
    recoveryOwedIds() {
      return memoryJournalSet(this.recoveryOwed).values()
    },
    receiptCount: 0,
    queueRevision: 0,
    revision: 0
  }
}

export function memoryJournalInputCardFacts(): JournalInputCardFacts {
  return {
    overlays: new Map<string, QueuedMessageRow>(),
    overlayCards() {
      return memoryJournalMap(this.overlays).values()
    },
    replaceOverlays(cards) {
      this.overlays = cards
    },
    overlayRows: [],
    revision: 0,
    initialized: false,
    firstPosition: 0,
    lastPosition: 0,
    floor: null
  }
}

export function memoryJournalInputObservationFacts(): JournalInputObservationFacts {
  const recoveredUnknown = new Set<string>()
  return {
    providerInputs: new Map(),
    providerByInput: new Map(),
    inputIds: new Map(),
    dispatchByFence: new Map(),
    signedOutByFence: new Map(),
    fences: new Map(),
    recoveredUnknown,
    recoveredUnknownIds() {
      return memoryJournalSet(this.recoveredUnknown).values()
    }
  }
}

export function memoryJournalInputEvidenceFacts(): JournalInputEvidenceFacts {
  const recoverable = new Map<string, AgentJournalSubmission>()
  const statusPending = new Map<string, AgentJournalSubmission>()
  return {
    recoverable,
    submissionRows: new Map(),
    rowsBySubmission: new Map(),
    keptCards: new Map(),
    keptBySubmission: new Map(),
    ordinals: new Map(),
    statusPending,
    steers: new Map(),
    steerTurns: new Map(),
    stoppedCandidates: new Set(),
    carrierCoverage: new Map(),
    coveredBy: new Map(),
    recoverableSubmissions() {
      return memoryJournalMap(this.recoverable).values()
    },
    statusPendingIds() {
      return memoryJournalMap(this.statusPending).keys()
    },
    nextOrdinal: 0,
    personAcceptedSequence: 0
  }
}

export function memoryJournalSubmissionLinkFacts(): JournalSubmissionLinkFacts {
  const linked = new Map<string, JournalKeyedMap<string, AgentJournalSubmission>>()
  return {
    linked,
    ids: new Map(),
    latest: new Map(),
    familyMembers(family) {
      const members = this.linked.get(family)
      return members ? memoryJournalMap(members).values() : []
    },
    familyMemberIds(family) {
      const members = this.linked.get(family)
      return members ? memoryJournalMap(members).keys() : []
    },
    revision: 0,
    acceptedHandoverAt: 0
  }
}
