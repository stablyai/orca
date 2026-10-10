import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentSessionStopTargetIsLive,
  type AgentSessionStopTarget
} from '../../../shared/agent-session-stop-target'
import { structuredAgentSessionStopTookEffect } from './structured-agent-session-stopping'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

type StopTargetObservation =
  | { verdict: 'live'; turnId?: string }
  | { verdict: 'exited' }
  | { verdict: 'unverifiable' }

/** Missing message linkage is uncertainty; only the execution host can bind an opening turn. */
export function observeStructuredAgentSessionStopTarget(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'adapter' | 'sessionId'>,
  target: AgentSessionStopTarget
): StopTargetObservation {
  const activeTurnId = ctx.journal.activeTurnId()
  const submissions = ctx.journal.submissions()
  if (target.kind !== 'submission') {
    return agentSessionStopTargetIsLive(target, activeTurnId, submissions, ctx.fence)
      ? { verdict: 'live' }
      : { verdict: 'exited' }
  }
  const submission = submissions.find((entry) => entry.clientMessageId === target.clientMessageId)
  if (!submission) {
    return { verdict: 'unverifiable' }
  }
  if (
    submission.dispatchState === 'rejected' ||
    submission.recovered === true ||
    (submission.fence < ctx.fence && !isQueuedAgentJournalSubmission(submission))
  ) {
    return { verdict: 'exited' }
  }
  if (
    activeTurnId !== null &&
    agentSessionStopTargetIsLive(
      target,
      activeTurnId,
      submissions,
      ctx.fence,
      ctx.journal.newestTurn()?.userItemId
    )
  ) {
    return { verdict: 'live', turnId: activeTurnId }
  }
  const identity = submission.providerItemId
    ? parseAgentJournalItemKey(submission.providerItemId)
    : null
  const linkedTurnId =
    identity?.provider === 'codex'
      ? identity.turnId
      : identity?.provider === 'claude'
        ? identity.uuid
        : undefined
  const observed = ctx.adapter.observeSubmissionTurn?.({
    sessionId: ctx.sessionId,
    clientMessageId: target.clientMessageId,
    fence: ctx.fence
  })
  const turnId = linkedTurnId ?? (observed?.verdict === 'live' ? observed.turnId : undefined)
  if (turnId !== undefined) {
    const turn = ctx.journal
      .snapshot()
      .items.findLast((item) => item.body.kind === 'turn' && item.body.turnId === turnId)?.body
    if (
      (activeTurnId !== null && activeTurnId !== turnId) ||
      (turn?.kind === 'turn' && turn.state !== 'running')
    ) {
      return { verdict: 'exited' }
    }
    if (observed?.verdict === 'live') {
      return { verdict: 'live', turnId }
    }
  }
  if (observed?.verdict === 'exited') {
    return observed
  }
  if (activeTurnId !== null) {
    return { verdict: 'unverifiable' }
  }
  // A Stop of everything in flight that took effect after the send reached the agent ended it.
  const latestStop = ctx.journal.stopMarks.latest()
  const reachedAgentAt =
    ctx.journal.item(agentJournalSubmissionKey(submission.clientMessageId))?.sequence ??
    submission.submittedSequence
  if (
    latestStop !== null &&
    latestStop.event.turnId === undefined &&
    structuredAgentSessionStopTookEffect(latestStop) &&
    reachedAgentAt !== undefined &&
    latestStop.sequence > reachedAgentAt
  ) {
    return { verdict: 'exited' }
  }
  if (agentSessionStopTargetIsLive(target, null, submissions, ctx.fence)) {
    return { verdict: 'live' }
  }
  // Answered, and no turn runs now: its own turn already ended.
  return submission.dispatchState === 'accepted'
    ? { verdict: 'exited' }
    : { verdict: 'unverifiable' }
}
