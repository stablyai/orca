import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { DerivedQueuePause } from '../../agent-session-journal/queued-messages/queued-message-pause'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

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
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume'>,
  fence: number,
  receipt?: JournalOperationReceipt
): Promise<boolean> {
  if (structuredQueuePauses(journal).length === 0) {
    return false
  }
  await journal.appendQueueResume(fence, receipt)
  return true
}

/** A person's chosen continuation is their recovery from a restart; other pauses keep their own lift. */
export async function liftStructuredQueueRestartHold(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume'>,
  fence: number
): Promise<void> {
  const pauses = structuredQueuePauses(journal)
  if (pauses.length > 0 && pauses.every((pause) => pause.reason === 'restarted')) {
    await journal.appendQueueResume(fence)
  }
}
