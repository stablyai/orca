// Whether a session was genuinely working when this process stopped it, and what it was doing.
//
// Read off the LIVE host state, never off a persisted status field. That distinction is the whole
// safety argument: a `running` turn row left behind by an older crash is still sitting in that
// session's journal, and a rule that trusted it would hand a provider child back to work nobody is
// doing. A crashed generation has no live session in this host, so it can never produce a marker.
//
// "Working" is what the sidebar showed, not the lead alone: a lead mid-turn, a lead blocked on the
// user, or a settled lead whose subagents, commands or monitors were still running all count. It is
// asked once per session, right before that session's child is stopped, and that answer is the
// offer. The same snapshot also records WHAT was cut off — the lead's own state, the pending
// prompts and the live child roster — because that fact exists only here: once reattached, the
// provider rewrites the journal in its own words.

import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import { latestStructuredAgentSessionUserItem } from '../../../shared/structured-agent-session-projection'
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
import {
  AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS,
  type AgentSessionRestartActivity,
  type AgentSessionRestartPrompt,
  type AgentSessionRestartTask
} from '../../../shared/agent-session-restart-activity'
import { isLiveChildWork } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionShownStatus } from './structured-agent-session-shown-work'

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

/**
 * The identity a marker carries: the lead's work in flight, else its newest turn. A settled lead
 * whose children were the work anchors there; the identity keys the continuation's ledger entry.
 */
function structuredAgentSessionResumeWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionResumeWork | null {
  const inFlight = structuredAgentSessionWorkInFlight(items, submissions)
  if (inFlight) {
    return inFlight
  }
  const newest = newestStructuredAgentSessionTurn(items)
  return newest ? { kind: 'turn', id: newest.turnId } : null
}

function boundedLabel(text: string | undefined): string {
  const trimmed = text?.trim() ?? ''
  return trimmed.length > AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH - 1)}…`
    : trimmed
}

/** The prompts the session is blocked on, from the same items the projection called `attention`
 *  over — one read, so the recorded state and the prompts it stands for cannot disagree. */
function pendingPrompts(items: readonly AgentJournalRenderItem[]): AgentSessionRestartPrompt[] {
  const prompts: AgentSessionRestartPrompt[] = []
  for (const item of items) {
    const body = item.body
    if (
      (body.kind !== 'approval' && body.kind !== 'question') ||
      body.resolution.state !== 'pending'
    ) {
      continue
    }
    prompts.push(
      body.kind === 'approval'
        ? { kind: 'approval', label: boundedLabel(body.displayName ?? body.title) }
        : { kind: 'question', label: boundedLabel(body.question) }
    )
    if (prompts.length === AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS) {
      break
    }
  }
  return prompts
}

/** The live child records, by the same liveness rule the sidebar's fold counts. */
function liveTasks(
  childWork: readonly AgentChildWorkView[] | undefined
): AgentSessionRestartTask[] {
  return (childWork ?? [])
    .filter((child) => isLiveChildWork(child))
    .slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS)
    .map((child) => ({ kind: child.kind, label: boundedLabel(child.description ?? child.name) }))
}

type WorkingCandidateSession = {
  journal: AgentSessionJournal
  /** Only this host generation's own child counts. A restored-for-reading journal has none. */
  hasProviderChild: boolean
  fence?: number
}

/** The offer one session is owed, taken right before teardown stops its provider child; null when
 *  the sidebar would not have shown it working. */
export function structuredAgentSessionWorkingAtStop(input: {
  sessionId: string
  session: WorkingCandidateSession | undefined
  getRecord: (sessionId: string) => AgentSessionRecord | null
  /** The session's child records, the same read the status feed publishes. */
  childWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  trigger: AgentSessionResumeTrigger
  /** Stable teardown identity for continuation deduplication, not launch ancestry. */
  teardownId: string
  now: number
}): AgentSessionResumeMarker | null {
  const { sessionId, session } = input
  // A journal this host cannot read tells us nothing about what the turn was doing.
  if (!session?.hasProviderChild || session.journal.isReadOnly) {
    return null
  }
  const snapshot = session.journal.snapshot()
  const childWork = input.childWork(sessionId)
  const status = structuredAgentSessionShownStatus(snapshot, childWork, session.fence)
  if (status.state === 'done') {
    return null
  }
  const work = structuredAgentSessionResumeWork(snapshot.items, snapshot.submissions)
  const head = agentSessionProviderHandleChainHead(
    input.getRecord(sessionId)?.providerHandleChain ?? []
  )
  if (!work || !head) {
    return null
  }
  const activity: AgentSessionRestartActivity = {
    // The lead's OWN state, not the fold: a settled lead with running children reads `done` here
    // and carries them in `tasks`, which is how the dialog tells the two apart.
    state: status.mainAgent.state,
    prompts: pendingPrompts(snapshot.items),
    tasks: liveTasks(childWork)
  }
  return {
    sessionId,
    work,
    latestUserItemId: latestStructuredAgentSessionUserItem(snapshot.items)?.itemId ?? null,
    recordedAt: input.now,
    trigger: input.trigger,
    teardownId: input.teardownId,
    // Root, not key: the close path advances Claude's leaf moments after this runs, and a key
    // comparison would then refuse the session forever.
    providerHandleRoot: agentSessionProviderHandleRoot(head.handle),
    // Before the stop: closing the child is what settles its children's rows, and the description
    // must be the roster the sidebar was still showing.
    activity
  }
}
