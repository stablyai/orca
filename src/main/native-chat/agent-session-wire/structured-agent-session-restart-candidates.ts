// Which of a set of markers the predicate would still act on, read off the host's own live journals.
//
// A different question from storage: the durable record decides which markers are still present;
// this decides which of those describe work a resume may touch. The offer, the click and the
// teardown write-back all ask it, each with a different lease expectation.
//
// The per-session journal snapshot is cached for the length of one call: the predicate asks the
// same session for its items four times, and a snapshot that moved between those reads would let
// two clauses judge two different conversations.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import {
  latestStructuredAgentSessionPrompt,
  latestStructuredAgentSessionUserItem,
  newestStructuredAgentSessionTurn,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumeCandidate
} from './structured-agent-session-restart-resume-set'

/** The only part of a live session this reads. */
export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateOptions = {
  /** Only teardown may judge before it rewrites the stopped child's running turn. */
  providerStopped?: boolean
  /** A continuation already in flight; its own submission is not newer user work. */
  pendingContinuationId?: string
}

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held',
  options?: StructuredAgentSessionRestartCandidateOptions
) => StructuredAgentSessionResumeCandidate[]

/** The newest user message in a live session's journal, the same fact the predicate compares
 *  against a marker. Undefined when the session is not readable here, which decides nothing. */
export function liveStructuredAgentSessionLatestUserItemId(
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>,
  sessionId: string
): string | null | undefined {
  const session = sessions.get(sessionId)
  return session
    ? (latestStructuredAgentSessionUserItem(session.journal.snapshot().items)?.itemId ?? null)
    : undefined
}

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** The host's LIVE session map — the only honest answer to "was this actually working". */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  now: () => number
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState, options = {}) => {
    const items = new Map<string, AgentJournalRenderItem[]>()
    const itemsFor = (sessionId: string): AgentJournalRenderItem[] => {
      let snapshot = items.get(sessionId)
      if (!snapshot) {
        snapshot = deps.sessions.get(sessionId)?.journal.snapshot().items ?? []
        if (options.pendingContinuationId) {
          const ownItemId = agentJournalSubmissionKey(options.pendingContinuationId)
          snapshot = snapshot.filter((item) => item.itemId !== ownItemId)
        }
        items.set(sessionId, snapshot)
      }
      return snapshot
    }
    return structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
      waitingOnUser: (sessionId) =>
        projectStructuredAgentSessionStatus(itemsFor(sessionId)) === 'attention',
      providerStopped: options.providerStopped === true,
      journalTurn: (sessionId) => newestStructuredAgentSessionTurn(itemsFor(sessionId)),
      journalSubmission: (sessionId, clientMessageId) =>
        deps.sessions
          .get(sessionId)
          ?.journal.submissions()
          .find((submission) => submission.clientMessageId === clientMessageId) ?? null,
      latestPrompt: (sessionId) => latestStructuredAgentSessionPrompt(itemsFor(sessionId)),
      latestUserItemId: (sessionId) =>
        latestStructuredAgentSessionUserItem(itemsFor(sessionId))?.itemId ?? null,
      now: deps.now(),
      leaseState
    })
  }
}
