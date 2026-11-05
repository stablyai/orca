import { readJournalDerived } from '../agent-session-journal/journal-derived-read'
import { latestStructuredAgentSessionPromptSteps } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
// Recheck stored offers against live journals and the same launch support used by startup.

import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
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
  leaseState: 'must-be-released' | 'may-be-held',
  previews?: ReadonlyMap<string, string> | false
) => StructuredAgentSessionResumableSet

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** Only explicit actions open marker chats; passive listings use saved previews. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  agents: Pick<StructuredAgentRegistry, 'definition'>
  movedOn: (marker: AgentSessionResumeMarker) => boolean
  savedByNewerOrca: (sessionId: string) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState, previews) =>
    structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => hostCanStartRecord(deps, record),
      movedOn: deps.movedOn,
      savedByNewerOrca: deps.savedByNewerOrca,
      latestPrompt: (sessionId) => {
        if (previews === false) {
          return ''
        }
        if (previews) {
          return previews.get(sessionId) ?? deps.getRecord(sessionId)?.lastTurn?.prompt ?? ''
        }
        const session = deps.sessions.get(sessionId)
        return session
          ? latestStructuredAgentSessionPrompt(session.journal.itemsRead().items)
          : (deps.getRecord(sessionId)?.lastTurn?.prompt ?? '')
      },
      leaseState
    })
}

/** Listing skips newer chats; pre-send must retain them so refused sends preserve their offers. */
export function createStructuredAgentSessionRestartCandidateReaders(
  deps: Parameters<typeof createStructuredAgentSessionRestartCandidateReader>[0]
): {
  derive: StructuredAgentSessionRestartCandidateReader
  deriveAtSend: StructuredAgentSessionRestartCandidateReader
  deriveFinite: (
    markers: readonly AgentSessionResumeMarker[],
    leaseState: 'must-be-released' | 'may-be-held'
  ) => Promise<StructuredAgentSessionResumableSet>
} {
  const derive = createStructuredAgentSessionRestartCandidateReader(deps)
  return {
    derive,
    deriveFinite: async (markers, leaseState) => {
      const previews = new Map<string, string>()
      for (const marker of markers) {
        const session = deps.sessions.get(marker.sessionId)
        if (session) {
          const journal = session.journal
          const prompt = await readJournalDerived(journal, function* (finite) {
            if (finite) {
              yield* journal.preparePublicReadSteps()
            }
            return yield* latestStructuredAgentSessionPromptSteps(journal.itemsRead().items)
          })
          if (deps.sessions.get(marker.sessionId) === session) {
            previews.set(marker.sessionId, prompt)
          }
        }
      }
      return derive(markers, leaseState, previews)
    },
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
