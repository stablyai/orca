// A person's send that only now finds the old account still busy goes back to the queue.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { USER_MESSAGE_SOURCE } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type Journal = StructuredAgentSessionHostSession['journal']

/** Whether `next` is work the old account must not take: the person's own send, or a queued card
 *  of theirs (a card's attempt carries its body, which only agent mail gives a sender). */
async function personsWork(journal: Journal, next: AgentJournalSubmission): Promise<boolean> {
  if (next.queuedMessageId === undefined) {
    return next.source?.kind === USER_MESSAGE_SOURCE.kind
  }
  const body = await journal.reads.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  return body?.kind === 'message' && body.from === undefined && !body.command
}

/** Keeps the person's unsent `next` waiting in the queue, so the agent on the old account never
 *  takes it and the mail behind it can still reach that agent: a fresh send becomes the first card,
 *  a card's attempt is proven undelivered so its card waits again. Work that is not the person's
 *  is left to deliver; a failed keep leaves the send pending for the next pass. */
export async function keepStructuredAgentSessionSendForAccountMove(
  sessionId: string,
  journal: Journal,
  fence: number,
  next: AgentJournalSubmission,
  logger: StructuredAgentSessionLogger
): Promise<'kept' | 'failed' | 'not-persons'> {
  let kept = false
  try {
    if (!(await personsWork(journal, next))) {
      return 'not-persons'
    }
    const only = { clientMessageId: next.clientMessageId, fence: next.fence }
    await (next.queuedMessageId === undefined
      ? journal.write({
          kind: 'hold-unsent',
          fence,
          hold: { cause: 'accountMove', select: { only } }
        })
      : journal.write({
          kind: 'queued-reject',
          fence,
          select: { only },
          rejection: undeliveredForMove()
        }))
    kept = (await journal.reads.submission(next.clientMessageId))?.dispatchState === 'rejected'
  } catch (error) {
    logger.warn('keeping a send for the account move failed', {
      scope: 'account-transition',
      sessionId,
      error
    })
  }
  logger.warn(
    kept
      ? 'holding a send until the chat can move to the account it now uses'
      : 'withholding a send from the old account until it can be kept',
    { scope: 'account-transition', sessionId, send: next.clientMessageId }
  )
  return kept ? 'kept' : 'failed'
}

/** Proven never written, so a card's attempt returns its card to waiting with no error row. */
function undeliveredForMove() {
  return agentSessionFailureWords(
    agentSessionFailureFact('notDelivered', { neverReachedAgent: true }),
    {
      surface: 'rejection'
    }
  )
}

const KEEP_RETRY_MS = 5_000
const KEEP_RETRY_MAX_MS = 5 * 60_000

/** Retries of a keep that failed, per chat: nothing else wakes a send left pending, so each tries
 *  again later than the last, never in a tight loop, until a keep settles. */
export class AccountMoveKeepRetries {
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; ms: number }>()

  constructor(private readonly wake: (sessionId: string) => void) {}

  failed(sessionId: string): void {
    const previous = this.retries.get(sessionId)
    const ms = previous ? Math.min(previous.ms * 2, KEEP_RETRY_MAX_MS) : KEEP_RETRY_MS
    const timer = setTimeout(() => this.wake(sessionId), ms)
    timer.unref?.()
    this.retries.set(sessionId, { timer, ms })
  }

  settled(sessionId: string): void {
    clearTimeout(this.retries.get(sessionId)?.timer)
    this.retries.delete(sessionId)
  }

  dispose(): void {
    for (const { timer } of this.retries.values()) {
      clearTimeout(timer)
    }
    this.retries.clear()
  }
}
