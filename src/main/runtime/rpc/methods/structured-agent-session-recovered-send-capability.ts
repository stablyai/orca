// Transitional: remove once no supported release lacks AGENT_SESSION_RECOVERED_SEND_CAPABILITY.
//
// A send a crash or a dead agent left in doubt for good (`unknown`, `recovered`) is drawn as an
// ordinary sent message, as is an older host's inferred `not_delivered`. A client that predates
// that reading draws the first unconfirmed, with a Retry that holds its queue, and hides the
// second behind a Retry, so the host publishes both to it as `accepted` — the one state it already
// draws as sent — at the RPC boundary only. The journal and every host reader keep the real facts,
// and the host never re-sends such a send whichever way it is published.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_RECOVERED_SEND_CAPABILITY } from '../../../../shared/protocol-version'
import { structuredAgentSessionSubmissionSettlement } from '../../../../shared/structured-agent-session-submission-settlement'
import type { RpcContext } from '../core'

type RecoveredSendReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsRecoveredSends(ctx: RecoveredSendReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate the reading.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_RECOVERED_SEND_CAPABILITY) === true
  )
}

function projectSubmission(submission: AgentJournalSubmission): AgentJournalSubmission {
  // The same reading a current client draws from, so the two cannot drift apart.
  if (
    submission.dispatchState === 'accepted' ||
    structuredAgentSessionSubmissionSettlement(submission) !== 'sent'
  ) {
    return submission
  }
  const { recovered: _recovered, rejection: _rejection, ...rest } = submission
  return { ...rest, dispatchState: 'accepted', reason: null }
}

function projectSubmissions(submissions: AgentJournalSubmission[]): AgentJournalSubmission[] {
  return submissions.some((submission) => projectSubmission(submission) !== submission)
    ? submissions.map(projectSubmission)
    : submissions
}

function projectPage(page: AgentSessionHistoryPage): AgentSessionHistoryPage {
  const submissions = projectSubmissions(page.submissions)
  return submissions === page.submissions ? page : { ...page, submissions }
}

export function projectRecoveredSendHistory(
  result: AgentSessionHistoryResult,
  ctx: RecoveredSendReader
): AgentSessionHistoryResult {
  if (readsRecoveredSends(ctx)) {
    return result
  }
  const page = projectPage(result.page)
  return page === result.page ? result : { ...result, page }
}

export function projectRecoveredSendEvent(
  event: AgentSessionSubscribeEvent,
  ctx: RecoveredSendReader
): AgentSessionSubscribeEvent {
  if (readsRecoveredSends(ctx)) {
    return event
  }
  if (event.type === 'batch') {
    const submissions = projectSubmissions(event.batch.submissions)
    return submissions === event.batch.submissions
      ? event
      : { ...event, batch: { ...event.batch, submissions } }
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    const page = projectPage(event.page)
    return page === event.page ? event : { ...event, page }
  }
  return event
}

/** A replayed send answers with its recorded submission, which may be a recovered one. */
export function projectRecoveredSendResult(
  result: AgentSessionMutationResult<AgentSessionSendResult>,
  ctx: RecoveredSendReader
): AgentSessionMutationResult<AgentSessionSendResult> {
  if (readsRecoveredSends(ctx) || !result.ok) {
    return result
  }
  const submission = projectSubmission(result.value.submission)
  return submission === result.value.submission
    ? result
    : { ...result, value: { ...result.value, submission } }
}
