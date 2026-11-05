import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalIndexedInputCard } from './journal-input-domain-index'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type { DerivedQueuePause } from './queued-message-pause'

export type JournalInputOrderFacts = {
  recoveryOwed: JournalKeyedSet<string>
  originals: JournalKeyedMap<string, AgentJournalCursor | undefined>
  queued: JournalKeyedMap<string, AgentJournalSubmission>
  entered: JournalKeyedMap<string, AgentJournalSubmission>
  overrides: JournalKeyedMap<string, AgentJournalSubmission>
  firstQueued: () => AgentJournalSubmission | undefined
  explicitSend: () => AgentJournalSubmission | undefined
  enteredSubmissions: () => Iterable<AgentJournalSubmission>
  recoveryOwedIds: () => Iterable<string>
  reconstructing: boolean
  legacyPlaces: number
  receiptCount: number
  queueRevision: number
  revision: number
}

export type JournalInputCardFacts = {
  current: JournalKeyedMap<string, QueuedMessageRow>
  indexed: JournalKeyedMap<string, JournalIndexedInputCard>
  unintroduced: JournalKeyedSet<string>
  overlays: JournalKeyedMap<string, QueuedMessageRow>
  cleared: JournalKeyedSet<string>
  currentCards: () => Iterable<QueuedMessageRow>
  overlayCards: () => Iterable<QueuedMessageRow>
  unintroducedIds: () => Iterable<string>
  replaceOverlays: (cards: Map<string, QueuedMessageRow>) => void
  replaceClearMembers: (ids: readonly string[]) => void
  history: boolean
  currentRevision: number
  initialized: boolean
  overlayRows: readonly QueuedMessageRow[]
  pauseKey: readonly unknown[]
  floor: AgentJournalCursor | null
  pauses: readonly DerivedQueuePause[]
  failed: boolean
}

export type JournalInputObservationFacts = {
  providerInputs: JournalKeyedMap<string, JournalInputPlaceStorage>
  providerByInput: JournalKeyedMap<string, string>
  inputIds: JournalKeyedMap<string, string>
  dispatchByFence: JournalKeyedMap<number, JournalInputPlaceStorage>
  signedOutByFence: JournalKeyedMap<number, JournalKeyedSet<string>>
  fences: JournalKeyedMap<string, number>
  recoveredUnknown: JournalKeyedSet<string>
  recoveredUnknownIds: () => Iterable<string>
}

export type JournalInputEvidenceFacts = {
  recoverable: JournalKeyedMap<string, AgentJournalSubmission>
  submissionRows: JournalKeyedMap<number, string>
  rowsBySubmission: JournalKeyedMap<string, number>
  keptCards: JournalKeyedMap<string, JournalKeyedSet<string>>
  keptBySubmission: JournalKeyedMap<string, string>
  ordinals: JournalKeyedMap<string, number>
  statusPending: JournalKeyedMap<string, AgentJournalSubmission>
  steers: JournalKeyedMap<string, JournalInputPlaceStorage>
  steerTurns: JournalKeyedMap<string, string>
  stoppedCandidates: JournalKeyedSet<string>
  carrierCoverage: JournalKeyedMap<string, readonly string[]>
  coveredBy: JournalKeyedMap<string, JournalKeyedSet<string>>
  recoverableSubmissions: () => Iterable<AgentJournalSubmission>
  statusPendingIds: () => Iterable<string>
  nextOrdinal: number
}

export type JournalSubmissionLinkFacts = {
  linked: JournalKeyedMap<string, JournalKeyedMap<string, AgentJournalSubmission>>
  ids: JournalKeyedMap<string, { family: string; sequence: number }>
  latest: JournalKeyedMap<string, string>
  familyMembers: (family: string) => Iterable<AgentJournalSubmission>
  familyMemberIds: (family: string) => Iterable<string>
  revision: number
  /** Provider-accepted handover position, which can follow the admission coordinate. */
  acceptedHandoverAt: number
}

export type JournalInputLineageFacts = {
  cards: JournalKeyedMap<string, JournalInputCard>
  base: number
  clock: number
  frontier: (entries: JournalKeyedMap<string, JournalInputEntry>) => number
  cardsForRelease: () => Iterable<[string, JournalInputCard]>
}
