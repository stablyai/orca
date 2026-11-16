// A person's send that only now finds the old account still busy goes back to the queue.

import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { USER_MESSAGE_SOURCE } from '../../../../shared/agent-session/agent-session-message-source'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

/** Keeps the person's unsent `next` as the queue's first card, so the agent on the old account
 *  never takes it and the mail behind it can still reach that agent. True once it is kept. */
export async function keepStructuredAgentSessionSendForAccountMove(
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  fence: number,
  next: AgentJournalSubmission,
  logger: StructuredAgentSessionLogger
): Promise<boolean> {
  if (next.source?.kind !== USER_MESSAGE_SOURCE.kind || next.queuedMessageId !== undefined) {
    return false
  }
  const only = { clientMessageId: next.clientMessageId, fence: next.fence }
  try {
    await journal.write({
      kind: 'hold-unsent',
      fence,
      hold: { cause: 'accountMove', select: { only } }
    })
  } catch (error) {
    logger.warn('keeping a send for the account move failed', {
      scope: 'account-transition',
      sessionId,
      error
    })
  }
  const kept = (await journal.reads.submission(next.clientMessageId))?.dispatchState === 'rejected'
  if (kept) {
    logger.warn('holding a send until the chat can move to the account it now uses', {
      scope: 'account-transition',
      sessionId,
      kept: next.clientMessageId
    })
  }
  return kept
}
