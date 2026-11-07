import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

export type JournalInputOrderFacts = {
  recoveryOwed: JournalKeyedSet<string>
  queued: JournalKeyedMap<string, AgentJournalSubmission>
  entered: JournalKeyedMap<string, AgentJournalSubmission>
  firstQueued: () => AgentJournalSubmission | undefined
  enteredSubmissions: () => Iterable<AgentJournalSubmission>
  recoveryOwedIds: () => Iterable<string>
  receiptCount: number
  queueRevision: number
  revision: number
}

export type JournalInputCardFacts = {
  overlays: JournalKeyedMap<string, QueuedMessageRow>
  overlayCards: () => Iterable<QueuedMessageRow>
  replaceOverlays: (cards: Map<string, QueuedMessageRow>) => void
  overlayRows: readonly QueuedMessageRow[]
  revision: number
  initialized: boolean
  /** Lowest and highest position any row has held, for append and send-now placement. */
  firstPosition: number
  lastPosition: number
  floor: AgentJournalCursor | null
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
  personAcceptedSequence: number
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
