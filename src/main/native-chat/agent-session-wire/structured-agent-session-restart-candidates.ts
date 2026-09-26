// Which of a set of markers are still offers, read off the host's own live journals.
//
// A different question from storage: the durable record decides which markers are still present;
// this decides which of those a resume may act on. The offer, the click and the pre-send check all
// ask it, and all get the same answer.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumableSet
} from './structured-agent-session-restart-resume-set'

/** The only part of a live session this reads. */
export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held'
) => StructuredAgentSessionResumableSet

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** The host's live session map; a marker's chat is readable once listing has revealed it. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  /** Whether the chat moved on since the offer was taken; see the offer withdrawal. */
  movedOn: (marker: AgentSessionResumeMarker) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState) =>
    structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
      movedOn: deps.movedOn,
      latestPrompt: (sessionId) =>
        latestStructuredAgentSessionPrompt(
          deps.sessions.get(sessionId)?.journal.snapshot().items ?? []
        ),
      leaseState
    })
}
