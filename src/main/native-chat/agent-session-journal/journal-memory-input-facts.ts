import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { memoryJournalMap, memoryJournalSet } from './journal-memory-collections'
import type {
  JournalInputOrderFacts,
  JournalInputCardFacts,
  JournalInputObservationFacts,
  JournalInputEvidenceFacts,
  JournalSubmissionLinkFacts,
  JournalInputLineageFacts
} from './journal-input-facts-storage'
import type { JournalInputCard } from './input-order/journal-input-lineage'
import type { JournalKeyedMap } from './journal-keyed-storage'

export function memoryJournalInputOrderFacts(): JournalInputOrderFacts {
  const recoveryOwed = new Set<string>()
  const queued = new Map<string, AgentJournalSubmission>()
  const entered = new Map<string, AgentJournalSubmission>()
  const overrides = new Map<string, AgentJournalSubmission>()
  return {
    recoveryOwed,
    originals: new Map(),
    queued,
    entered,
    overrides,
    firstQueued() {
      return memoryJournalMap(this.queued).values().next().value
    },
    explicitSend() {
      return memoryJournalMap(this.overrides).values().next().value
    },
    enteredSubmissions() {
      return memoryJournalMap(this.entered).values()
    },
    recoveryOwedIds() {
      return memoryJournalSet(this.recoveryOwed).values()
    },
    reconstructing: false,
    legacyPlaces: 0,
    receiptCount: 0,
    queueRevision: 0,
    revision: 0
  }
}

export function memoryJournalInputCardFacts(): JournalInputCardFacts {
  const current = new Map<string, QueuedMessageRow>()
  const overlays = new Map<string, QueuedMessageRow>()
  const unintroduced = new Set<string>()
  return {
    current,
    indexed: new Map(),
    overlays,
    unintroduced,
    cleared: new Set(),
    currentCards() {
      return memoryJournalMap(this.current).values()
    },
    overlayCards() {
      return memoryJournalMap(this.overlays).values()
    },
    unintroducedIds() {
      return memoryJournalSet(this.unintroduced).values()
    },
    replaceOverlays(cards) {
      this.overlays = cards
    },
    replaceClearMembers(ids) {
      this.cleared = new Set(ids)
    },
    history: true,
    currentRevision: 0,
    initialized: false,
    overlayRows: [],
    pauseKey: [],
    pauseKeyMatches(inputs) {
      return inputs.every((value, i) => value === this.pauseKey[i])
    },
    floor: null,
    pauses: [],
    failed: false
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
    nextOrdinal: 0
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

export function memoryJournalInputLineageFacts(
  cards: JournalKeyedMap<string, JournalInputCard>
): JournalInputLineageFacts {
  return {
    cards,
    base: 0,
    clock: 0,
    frontier(entries) {
      let frontier = 0
      for (const entry of memoryJournalMap(entries).values()) {
        frontier = Math.max(frontier, entry.context.cut)
      }
      for (const card of memoryJournalMap(this.cards).values()) {
        frontier = Math.max(frontier, card.introduced)
      }
      return frontier
    },
    cardsForRelease() {
      return memoryJournalMap(this.cards).entries()
    }
  }
}
