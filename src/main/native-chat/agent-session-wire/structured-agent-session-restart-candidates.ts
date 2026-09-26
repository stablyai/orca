// Which of a set of markers are still offers, read off the host's own live journals.
//
// A different question from storage: the durable record decides which markers are still present;
// this decides which of those a resume may act on. The offer, the click and the pre-send check all
// ask it, and all get the same answer: the marker stands until the user sends a newer message.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import {
  latestStructuredAgentSessionPrompt,
  latestStructuredAgentSessionUserItem
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumableSet,
  type StructuredAgentSessionResumableSet
} from './structured-agent-session-restart-resume-set'

/** The only part of a live session this reads. */
export type StructuredAgentSessionRestartJournalSource = { journal: AgentSessionJournal }

export type StructuredAgentSessionRestartCandidateOptions = {
  /** A continuation already in flight; its own submission is not newer user work. */
  pendingContinuationId?: string
}

export type StructuredAgentSessionRestartCandidateReader = (
  markers: readonly AgentSessionResumeMarker[],
  leaseState: 'must-be-released' | 'may-be-held',
  options?: StructuredAgentSessionRestartCandidateOptions
) => StructuredAgentSessionResumableSet

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
  /** The host's live session map; a marker's chat is readable once listing has revealed it. */
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
}): StructuredAgentSessionRestartCandidateReader {
  return (markers, leaseState, options = {}) => {
    const items = new Map<string, AgentJournalRenderItem[] | undefined>()
    const itemsFor = (sessionId: string): AgentJournalRenderItem[] | undefined => {
      if (items.has(sessionId)) {
        return items.get(sessionId)
      }
      let snapshot = deps.sessions.get(sessionId)?.journal.snapshot().items
      if (snapshot && options.pendingContinuationId) {
        const ownItemId = agentJournalSubmissionKey(options.pendingContinuationId)
        snapshot = snapshot.filter((item) => item.itemId !== ownItemId)
      }
      items.set(sessionId, snapshot)
      return snapshot
    }
    return structuredAgentSessionResumableSet({
      markers,
      getRecord: deps.getRecord,
      supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
      latestPrompt: (sessionId) => latestStructuredAgentSessionPrompt(itemsFor(sessionId) ?? []),
      latestUserItemId: (sessionId) => {
        const snapshot = itemsFor(sessionId)
        return snapshot === undefined
          ? undefined
          : (latestStructuredAgentSessionUserItem(snapshot)?.itemId ?? null)
      },
      leaseState
    })
  }
}
