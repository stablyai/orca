// Which of a set of markers are still offers, read off the host's own live journals.
//
// A different question from storage: the durable record decides which markers are still present;
// this decides which of those a resume may act on. The offer, the click and the pre-send check all
// ask it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../shared/structured-agent-session-latest-request'
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
  /** Whether the chat was saved by a newer Orca: its whole database, or its journal's open. */
  savedByNewerOrca: (sessionId: string) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState) =>
    structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
      movedOn: deps.movedOn,
      savedByNewerOrca: deps.savedByNewerOrca,
      latestPrompt: (sessionId) =>
        latestStructuredAgentSessionPrompt(
          deps.sessions.get(sessionId)?.journal.snapshot().items ?? []
        ),
      leaseState
    })
}

/** The listing's reader, which skips a newer Orca's chats, and the one right before sending, which
 *  skips nothing for them: turning one away there would spend its offer, so its send is refused
 *  instead and settling keeps the offer. */
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

/** Chats the latest reveal found saved by a newer Orca: listing skips them and never spends their
 *  offers. Each reveal re-derives its chat's entry; nothing is stored. */
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
