import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
// Capture live host work immediately before stopping its child; stale persisted turns must never create resume offers.
// Include pending prompts and running child work while that evidence still reflects the pre-stop state.

import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import { latestStructuredAgentSessionUserItem } from '../../../shared/structured-agent-session-latest-request'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
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
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  isStructuredAgentSessionCommandEntry,
  isStructuredAgentSessionCommandTurn
} from '../../../shared/structured-agent-session-command-entry'
import {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { isUnansweredHandedOverSubmission } from '../agent-session-journal/journal-unsent-send-hold'
import { structuredAgentSessionShownStatus } from './structured-agent-session-shown-work'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionWorkScope } from '../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

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

/** Prefer a current running turn, then its unanswered send; exclude ended generations. */
export function structuredAgentSessionWorkInFlight(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  scope?: StructuredAgentSessionWorkScope
): AgentSessionResumeWork | null {
  const current = agentSessionCurrentContextRows(items, submissions)
  const turnId = activeStructuredAgentSessionTurnId(
    current.items,
    scope && ((item) => scope.isCurrentItem(item.itemId))
  )
  if (turnId) {
    return { kind: 'turn', id: turnId }
  }
  const submission = pendingSubmissionInFlight(current.submissions)
  return submission ? { kind: 'submission', id: submission.clientMessageId } : null
}

/** Anchor settled leads with live children on their newest turn; identity deduplicates continuation. */
function structuredAgentSessionResumeWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  scope: StructuredAgentSessionWorkScope
): AgentSessionResumeWork | null {
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  const bodyOf = (itemId: string) => bodies.get(itemId)
  // Conversation commands are user work, so never resume them as agent work.
  const newest = newestStructuredAgentSessionTurn(items)
  const inFlightSubmission = pendingSubmissionInFlight(submissions)
  if (
    (newest?.state === 'running' && isStructuredAgentSessionCommandTurn(newest, bodyOf)) ||
    (inFlightSubmission &&
      isStructuredAgentSessionCommandEntry(
        bodyOf(agentJournalSubmissionKey(inFlightSubmission.clientMessageId))
      ))
  ) {
    return null
  }
  const inFlight = structuredAgentSessionWorkInFlight(items, submissions, scope)
  if (inFlight) {
    return inFlight
  }
  const lastRequest = items.findLast((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn !== null && !isStructuredAgentSessionCommandTurn(turn, bodyOf)
  })
  const turn = readAgentJournalTurn(lastRequest?.body)
  return turn ? { kind: 'turn', id: turn.turnId } : null
}

function boundedLabel(text: string | undefined): string {
  const trimmed = text?.trim() ?? ''
  return trimmed.length > AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH - 1)}…`
    : trimmed
}

/** Reuse the status snapshot so recorded attention state and prompt identities agree. */
function pendingPrompts(
  items: readonly AgentJournalRenderItem[],
  scope: StructuredAgentSessionWorkScope
): AgentSessionRestartPrompt[] {
  const prompts: AgentSessionRestartPrompt[] = []
  for (const item of items) {
    const body = item.body
    if (
      (body.kind !== 'approval' && body.kind !== 'question') ||
      body.resolution.state !== 'pending' ||
      !scope.isCurrentItem(item.itemId)
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
  /** Restored-for-reading journals have no child and cannot create offers. */
  child: Pick<StructuredAgentSessionProviderChild, 'fence' | 'phase' | 'heldSends'> | null
}

export function structuredAgentSessionWorkingAtStop(input: {
  sessionId: string
  session: WorkingCandidateSession | undefined
  getRecord: (sessionId: string) => AgentSessionRecord | null
  childWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  /** Include unrecorded live work rejected by bounded storage. */
  childWorkOpen: (sessionId: string) => boolean
  trigger: AgentSessionResumeTrigger
  teardownId: string
  now: number
}): AgentSessionResumeMarker | null {
  const { sessionId, session } = input
  if (!session?.child) {
    return null
  }
  const snapshot = session.journal.snapshot()
  const current = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
  // Queued/unanswered-start sends never reached an agent; reopen/exit keeps them as unsent.
  const unanswered = session.child.phase === 'starting'
  const handedOver = current.submissions.filter(
    (submission) =>
      !isQueuedAgentJournalSubmission(submission) &&
      !(unanswered && isUnansweredHandedOverSubmission(submission))
  )
  const childWork = input.childWork(sessionId)
  const record = input.getRecord(sessionId)
  // Trust the host’s own live child generation, never a restored lease.
  const { scope } = new StructuredAgentSessionCurrentWork(
    session.journal,
    session.child.fence,
    0,
    undefined,
    undefined,
    false,
    session.child.heldSends
  )
  const status = structuredAgentSessionShownStatus(
    { items: current.items, submissions: handedOver },
    childWork,
    session.child.fence,
    scope
  )
  // Unrecorded helpers still count as resumable work.
  if (status.state === 'done' && !input.childWorkOpen(sessionId)) {
    return null
  }
  const work = structuredAgentSessionResumeWork(current.items, handedOver, scope)
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  if (!work || !head) {
    return null
  }
  const activity: AgentSessionRestartActivity = {
    // Keep lead state separate from child tasks so the resume dialog can distinguish them.
    state: status.mainAgent.state,
    prompts: pendingPrompts(current.items, scope),
    tasks: liveTasks(childWork)
  }
  return {
    sessionId,
    work,
    latestUserItemId: latestStructuredAgentSessionUserItem(current.items)?.itemId ?? null,
    recordedAt: input.now,
    trigger: input.trigger,
    teardownId: input.teardownId,
    journalCursor: snapshot.cursor,
    ...(record?.providerContextBoundary
      ? { contextClearOperationId: record.providerContextBoundary.operationId }
      : {}),
    // Claude close advances the leaf; matching the key would permanently reject this offer.
    providerHandleRoot: agentSessionProviderHandleRoot(head.handle),
    // Capture before child exit settles the roster.
    activity
  }
}
