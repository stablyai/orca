// Recheck stored offers against live journals and the same launch support used by startup.

import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { hostCanStartRecord } from '../providers/structured-agent-session-provider-support'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumableSet
} from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held',
  movedOn?: (marker: AgentSessionResumeMarker) => boolean | 'unknown'
) => StructuredAgentSessionResumableSet

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** Only explicit actions open marker chats; passive listings use saved previews. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  agents: Pick<StructuredAgentRegistry, 'definition'>
  movedOn: (marker: AgentSessionResumeMarker) => boolean | 'unknown'
  savedByNewerOrca: (sessionId: string) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState, movedOn = deps.movedOn) =>
    structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => hostCanStartRecord(deps, record),
      movedOn,
      savedByNewerOrca: deps.savedByNewerOrca,
      latestPrompt: (sessionId) => {
        const session = deps.sessions.get(sessionId)
        return session
          ? latestStructuredAgentSessionPrompt(session.journal.itemsRead().items)
          : (deps.getRecord(sessionId)?.lastTurn?.prompt ?? '')
      },
      leaseState
    })
}

/** Cancellation and retryability share one observation inside a synchronous failure evaluation. */
export function failureEvaluator(
  personalStop: (marker: AgentSessionResumeMarker) => boolean | 'unknown',
  derive: StructuredAgentSessionRestartCandidateReader,
  withdrawal: {
    movedOnWithPersonalStop: (
      marker: AgentSessionResumeMarker,
      stopped: boolean
    ) => boolean | 'unknown'
  }
): (marker: AgentSessionResumeMarker) => { cancelled: boolean; retryable: boolean } {
  return (marker) => {
    const stopped = personalStop(marker)
    return {
      cancelled: stopped === true,
      retryable:
        stopped === false &&
        derive([marker], 'may-be-held', (selected) =>
          withdrawal.movedOnWithPersonalStop(selected, stopped)
        ).candidates.length === 1
    }
  }
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
