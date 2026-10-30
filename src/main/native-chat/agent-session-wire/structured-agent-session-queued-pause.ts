import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { DerivedQueuePause } from '../agent-session-journal/queued-message-pause'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages'>

export function structuredQueuePauses(journal: PauseJournal): DerivedQueuePause[] {
  return journal.queuedMessages.pauses()
}

/** Reopen holds waiting cards until the next turn; since preserves the original boundary after later sends.
 * Failures log and retain a conservative in-memory hold. */
export async function markStructuredQueueReopen(
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'markQueueReopen'>,
  fence: number,
  logger: StructuredAgentSessionLogger,
  since?: number
): Promise<void> {
  try {
    await journal.markQueueReopen(fence, since)
  } catch (error) {
    logger.warn('marking a reopened queue failed', {
      scope: 'queue-reopen-mark',
      sessionId,
      error
    })
  }
}

export async function resumeStructuredQueue(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume' | 'mailHoldFacts'>,
  fence: number,
  receipt?: JournalOperationReceipt
): Promise<boolean> {
  const mail = journal.mailHoldFacts()
  if (structuredQueuePauses(journal).length === 0 && !mail.held) {
    return false
  }
  await journal.appendQueueResume(fence, receipt)
  return true
}
