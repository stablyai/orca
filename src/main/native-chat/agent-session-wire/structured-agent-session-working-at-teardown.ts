// Which sessions were genuinely working when this process went away.
//
// Read off the LIVE host state, never off a persisted status field. That distinction is the whole
// safety argument: a `running` turn row left behind by an older crash is still sitting in that
// session's journal, and a rule that trusted it would hand a provider child back to work nobody is
// doing. A crashed generation leaves no entry in this map, so it can never produce a marker.
//
// Three facts have to line up for one marker, and each rules out a different false positive:
// this host is running the child (not a journal we merely opened for reading), the journal's newest
// turn is actually running (not one that completed before quit), and the session has a provider
// cursor to resume onto (not a conversation that never proved a thread).

import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import {
  latestStructuredAgentSessionUserItem,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger,
  AgentSessionResumeWork
} from '../../../shared/agent-session-resume-marker'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** A send Orca journaled that the provider has neither opened a turn for nor refused. Mirrors the
 *  projection's own unanswered-dispatch rule, which is what makes that window read as `working`. */
function pendingSubmissionInFlight(
  submissions: readonly AgentJournalSubmission[]
): AgentJournalSubmission | null {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const submission = submissions[index]
    if (
      submission &&
      submission.recovered !== true &&
      (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown')
    ) {
      return submission
    }
  }
  return null
}

/** The work identity to record: a running turn if one exists, else the send still awaiting one. */
export function structuredAgentSessionWorkInFlight(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionResumeWork | null {
  const turnId = activeStructuredAgentSessionTurnId(items)
  if (turnId) {
    return { kind: 'turn', id: turnId }
  }
  const submission = pendingSubmissionInFlight(submissions)
  return submission ? { kind: 'submission', id: submission.clientMessageId } : null
}

type WorkingCandidateSession = {
  journal: AgentSessionJournal
  /** Only this host generation's own child counts. A restored-for-reading journal has none. */
  hasProviderChild: boolean
}

export function structuredAgentSessionsWorkingAtTeardown(input: {
  sessions: ReadonlyMap<string, WorkingCandidateSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  trigger: AgentSessionResumeTrigger
  /** Stable teardown identity for continuation deduplication, not launch ancestry. */
  teardownId: string
  now: number
}): AgentSessionResumeMarker[] {
  const markers: AgentSessionResumeMarker[] = []
  for (const [sessionId, session] of input.sessions) {
    if (!session.hasProviderChild) {
      continue
    }
    // A journal this host cannot read tells us nothing about what the turn was doing.
    if (session.journal.isReadOnly) {
      continue
    }
    const snapshot = session.journal.snapshot()
    const status = projectStructuredAgentSessionStatus(snapshot.items, snapshot.submissions)
    // The product's own classification, so the marker rule cannot disagree with what the UI calls
    // working. A turn blocked on an approval or a question projects as `attention`: the agent is
    // waiting on the USER, and that is not interrupted work to hand back.
    //
    // Provider tail events are re-derived after exit, before eviction cancels pending prompts.
    if (status !== 'working') {
      continue
    }
    // A running turn when there is one; otherwise the send that has not become a turn YET. Claude
    // cannot write its turn until the SDK echoes the message back, and dropping the session for
    // that window under-offers exactly the chats that were working hardest.
    const work = structuredAgentSessionWorkInFlight(snapshot.items, snapshot.submissions)
    if (!work) {
      continue
    }
    const head = agentSessionProviderHandleChainHead(
      input.getRecord(sessionId)?.providerHandleChain ?? []
    )
    if (!head) {
      continue
    }
    markers.push({
      sessionId,
      work,
      latestUserItemId: latestStructuredAgentSessionUserItem(snapshot.items)?.itemId ?? null,
      recordedAt: input.now,
      trigger: input.trigger,
      teardownId: input.teardownId,
      // Root, not key: the close path advances Claude's leaf moments after this runs, and a key
      // comparison would then refuse the session forever.
      providerHandleRoot: agentSessionProviderHandleRoot(head.handle)
    })
  }
  return markers
}
