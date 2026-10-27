// Recheck stored offers against live journals and the same launch support used by startup.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../shared/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { hostCanStartRecord } from './structured-agent-session-provider-support'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumableSet
} from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held'
) => StructuredAgentSessionResumableSet

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** Listing reveals marker chats before these map reads. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  agents: Pick<StructuredAgentRegistry, 'definition'>
  movedOn: (marker: AgentSessionResumeMarker) => boolean
  savedByNewerOrca: (sessionId: string) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState) =>
    structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => hostCanStartRecord(deps, record),
      movedOn: deps.movedOn,
      savedByNewerOrca: deps.savedByNewerOrca,
      latestPrompt: (sessionId) =>
        latestStructuredAgentSessionPrompt(
          deps.sessions.get(sessionId)?.journal.snapshot().items ?? []
        ),
      leaseState
    })
}

/** Listing skips newer chats; pre-send must retain them so refused sends preserve their offers. */
export function createStructuredAgentSessionRestartCandidateReaders(
  deps: Parameters<typeof createStructuredAgentSessionRestartCandidateReader>[0]
): {
  derive: StructuredAgentSessionRestartCandidateReader
  deriveAtSend: StructuredAgentSessionRestartCandidateReader
} {
  return {
    derive: createStructuredAgentSessionRestartCandidateReader(deps),
    deriveAtSend: createStructuredAgentSessionRestartCandidateReader({
      ...deps,
      savedByNewerOrca: () => false
    })
  }
}

/** Transient newer-chat flags, re-derived by reveal; listing must never spend their offers. */
export function createNewerOrcaChats(databaseIsNewer: () => boolean) {
  const chats = new Set<string>()
  return {
    has: (sessionId: string): boolean => databaseIsNewer() || chats.has(sessionId),
    note: (sessionId: string, revealed: { openRefusal?: AgentSessionWireRefusal } | null): void => {
      if (revealed?.openRefusal?.details?.reason === 'journalWrittenByNewerOrca') {
        chats.add(sessionId)
      } else {
        chats.delete(sessionId)
      }
    }
  }
}
