// Recheck stored offers against live journals and the same launch support used by startup.

import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import { hostCanStartRecord } from '../providers/structured-agent-session-provider-support'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import {
  listProviderRelaysAtLaunch,
  providerRelayChatsIdleStoppedThisRun,
  providerRelayKeptFromLastRun,
  providerRelayRunLiveness,
  type ProviderRelayRunRecord
} from '../../../provider-relay/app-provider-relays'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumableSet
} from './structured-agent-session-restart-resume-set'
import { agentSessionRunPlacement } from '../../../../shared/agent-session/lifecycle/agent-session-run-placement'
import { providerRelayListedIdleStopped } from '../../../provider-relay/provider-relay-launch-inventory'

export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held'
) => Promise<StructuredAgentSessionResumableSet>

export function createStructuredAgentSessionRestartCandidateReader(deps: {
  /** Only explicit actions open marker chats; passive listings use saved previews. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  agents: Pick<StructuredAgentRegistry, 'definition'>
  movedOn: (marker: AgentSessionResumeMarker) => Promise<boolean>
  savedByNewerOrca: (sessionId: string) => boolean
}): StructuredAgentSessionRestartCandidateReader {
  return async (markers, leaseState) =>
    structuredAgentSessionResumableSet({
      // A chat whose agent kept working under the terminal host was never cut; it reattaches.
      markers: await withoutKeptRunningChats(markers, deps.getRecord),
      getRecord: deps.getRecord,
      supportsRecord: (record) => hostCanStartRecord(deps, record),
      movedOn: deps.movedOn,
      savedByNewerOrca: deps.savedByNewerOrca,
      latestPrompt: (sessionId) => {
        const session = deps.sessions.get(sessionId)
        return session
          ? session.journal.reads.latestPrompt()
          : (deps.getRecord(sessionId)?.lastTurn?.prompt ?? '')
      },
      leaseState
    })
}

async function withoutKeptRunningChats(
  markers: readonly AgentSessionResumeMarker[],
  getRecord: (sessionId: string) => ProviderRelayRunRecord | null | undefined
): Promise<readonly AgentSessionResumeMarker[]> {
  if (markers.length === 0) {
    return markers
  }
  await listProviderRelaysAtLaunch()
  const finished = providerRelayChatsIdleStoppedThisRun()
  // Its run may still be going (its daemon start lists it or can't say yet), or was already
  // reattached: either way its agent never stopped. One the daemon idle-stopped had finished its
  // work, so nothing was cut either. Each relayed run asks only its own daemon start.
  const reads = await Promise.all(
    markers.map(async ({ sessionId }) => {
      const record = getRecord(sessionId)
      if (!record) {
        return { mayRun: false, idleStopped: false }
      }
      const mayRun = (await providerRelayRunLiveness(record, { observe: true })) !== 'gone'
      // Read from the answer it just heard: an observer records nothing, idle stops included.
      const placement = agentSessionRunPlacement(record)
      const idleStopped =
        placement?.kind === 'relayed' &&
        providerRelayListedIdleStopped(placement.daemon.instance, placement.relayId)
      return { mayRun, idleStopped }
    })
  )
  return markers.filter(
    (marker, index) =>
      !reads[index].mayRun &&
      !reads[index].idleStopped &&
      !finished.has(marker.sessionId) &&
      !providerRelayKeptFromLastRun(marker.sessionId)
  )
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
