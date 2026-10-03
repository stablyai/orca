// The one writer of a failed agent start: the delivery loop, which records it on the message the
// start was for and on any message handed to that start's child, which took nothing. Its two
// entries keep the rule by construction: a start refused before it ran leaves its message in the
// queue with the next try booked, until out of tries; one that ran and failed can only reject each
// at once, for the person's Retry. The messages behind it go on meanwhile.

import {
  agentSessionFailureFact,
  isSubmissionRejectionFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRejectionCause,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionStartRetryAt } from '../../../shared/structured-agent-session-start-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  endStructuredAgentSessionCommandStartFailure,
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
} from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type StartFailureJournal = Pick<
  AgentSessionJournal,
  'submissions' | 'itemBody' | 'resolveDispatch' | 'appendLifecycleBatch'
>

type StartFailureWriter = {
  journal: StartFailureJournal
  fence: number
  record: AgentSessionRecord | null
  now: () => number
}

/** Who the message's sentence names, and the command its own body sends, so the next step is to run
 *  that command again rather than to send a message. */
function startFailureWordsContext(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  clientMessageId: string
): AgentSessionFailureWordsContext {
  const body = journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  const command =
    body?.kind === 'message' && body.command?.name === STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
      ? STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
      : undefined
  return {
    ...structuredAgentSessionFailureWordsContext(record),
    ...(command ? { command } : {})
  }
}

/**
 * A start the loop's own start step was refused, for `startedFor`. Refused before any provider
 * process, the message waits for its next try; otherwise — the start ran, the site that refused
 * said only the person can clear it, it is out of tries, or it is a conversation command — it is
 * rejected. A command never waits: like a goal, a rewind or /clear, its failure is the person's to
 * Retry at once. The one place a try is booked.
 */
export function recordStructuredAgentSessionStartRefusal(
  ctx: StartFailureWriter,
  cause: Extract<StructuredAgentSessionStartFailureCause, { refusal: unknown }>,
  startedFor: string
): Promise<void> {
  const retriesOnItsOwn = cause.beforeSpawn !== undefined && !cause.beforeSpawn.needsUser
  return recordStartFailure(ctx, cause, [startedFor], retriesOnItsOwn)
}

/**
 * A start that ran here and failed: each message it was for, and each it was handed, which it took
 * nothing of, is rejected at once for the person's Retry. A message that Stop withdrew meanwhile
 * is left alone.
 */
export function rejectStructuredAgentSessionFailedStart(
  ctx: StartFailureWriter,
  cause: StructuredAgentSessionStartFailureCause,
  clientMessageIds: readonly string[]
): Promise<void> {
  return recordStartFailure(ctx, cause, clientMessageIds, false)
}

async function recordStartFailure(
  ctx: StartFailureWriter,
  cause: StructuredAgentSessionStartFailureCause,
  clientMessageIds: readonly string[],
  retriesOnItsOwn: boolean
): Promise<void> {
  for (const clientMessageId of new Set(clientMessageIds)) {
    const submission = ctx.journal
      .submissions()
      .find((entry) => entry.clientMessageId === clientMessageId)
    if (submission?.dispatchState !== 'pending') {
      continue
    }
    const context = startFailureWordsContext(ctx.journal, ctx.record, clientMessageId)
    const words = structuredAgentSessionStartFailure(cause, context)
    const nextAttemptAt =
      retriesOnItsOwn && context.command === undefined
        ? structuredAgentSessionStartRetryAt((submission.startRetry?.attempts ?? 0) + 1, ctx.now())
        : null
    await ctx.journal.resolveDispatch(
      nextAttemptAt === null
        ? { clientMessageId, state: 'rejected', ...words, fence: ctx.fence }
        : {
            clientMessageId,
            state: 'pending',
            startRetry: {
              // Orca tries again on its own, so the sentence leaves out trying again.
              reason: structuredAgentSessionStartFailure(cause, { ...context, orcaRetries: true })
                .reason,
              rejection: words.rejection,
              nextAttemptAt
            },
            fence: ctx.fence
          }
    )
    // A command opens its turn at handover; that turn is over, and its message says why.
    await endStructuredAgentSessionCommandStartFailure(
      { journal: ctx.journal, fence: ctx.fence, now: ctx.now },
      clientMessageId
    )
  }
}

/** What a queued message is rejected with when it cannot wait any longer — the chat closed (`end`
 *  `chatClosed`), Orca quit or restarted (`hostRestarted`): the start failure it was waiting out,
 *  with what ended the wait as the submission's `rejectionCause`, else `end` itself. */
export function leftoverRejection(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  end: AgentJournalRejectionCause
): (
  submission: AgentJournalSubmission
) => AgentJournalDispatchRejection & { rejectionCause?: AgentJournalRejectionCause } {
  return (submission) => {
    const fact = readAgentSessionFailureFact(submission.startRetry?.rejection)
    if (!fact || !isSubmissionRejectionFact(fact)) {
      return agentSessionFailureWords(agentSessionFailureFact(end), { surface: 'rejection' })
    }
    return {
      ...agentSessionFailureWords(fact, {
        ...startFailureWordsContext(journal, record, submission.clientMessageId),
        surface: 'rejection'
      }),
      rejectionCause: end
    }
  }
}

/** The oldest queued message that may go now: not waiting out a refused start, or due again. Later
 *  messages overtake one that is waiting; one the person's Retry queued again goes first. */
export function nextDeliverableSubmission(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  now: number
): AgentJournalSubmission | undefined {
  let oldest: AgentJournalSubmission | undefined
  for (const submission of journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (submission.startRetry === undefined || submission.startRetry.nextAttemptAt <= now) &&
      (oldest === undefined || deliversBefore(submission, oldest))
    ) {
      oldest = submission
    }
  }
  return oldest
}

function deliversBefore(a: AgentJournalSubmission, b: AgentJournalSubmission): boolean {
  if (a.retriedInPlace !== b.retriedInPlace) {
    return a.retriedInPlace === true
  }
  return (a.acceptedSequence ?? 0) < (b.acceptedSequence ?? 0)
}

/** When the earliest message waiting out a refused start comes due after `now`; null when none
 *  does. One already due is the loop's to take, or waits on what holds it, never on a timer. */
export function nextStartRetryAt(
  journal: Pick<AgentSessionJournal, 'submissions'> | undefined,
  now: number
): number | null {
  let earliest: number | null = null
  for (const submission of journal?.submissions() ?? []) {
    const due = isQueuedAgentJournalSubmission(submission)
      ? submission.startRetry?.nextAttemptAt
      : undefined
    if (due !== undefined && due > now && (earliest === null || due < earliest)) {
      earliest = due
    }
  }
  return earliest
}

/** The wake for that try: a cache of the journal's earliest due time, never what decides it. */
export function setStartRetryTimer(delayMs: number, run: () => void): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** Messages handed to a child under `fence` and not answered: if that child never proved its start,
 *  it took none of them. */
export function submissionsHandedToChild(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  fence: number
): string[] {
  return journal
    .submissions()
    .filter(
      (submission) =>
        submission.dispatchState === 'pending' &&
        submission.handedOverAt !== undefined &&
        submission.fence === fence
    )
    .map((submission) => submission.clientMessageId)
}
