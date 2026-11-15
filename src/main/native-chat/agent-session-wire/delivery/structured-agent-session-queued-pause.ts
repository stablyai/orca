import type { JournalSubmissionSelector } from '../../agent-session-journal/journal-submission-selector'
import type { JournalWriterSettled } from '../../agent-session-journal/journal-sql-failure'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import type { UnsentSendHold } from '../../agent-session-journal/queued-messages/journal-unsent-send-hold'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { DerivedQueuePause } from '../../agent-session-journal/queued-messages/queued-message-pause'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages'>

export async function structuredQueuePauses(journal: PauseJournal): Promise<DerivedQueuePause[]> {
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
  if ((await structuredQueuePauses(journal)).length === 0) {
    return false
  }
  await journal.appendQueueResume(fence, receipt)
  return true
}

type ConversationCloseDeps = Pick<StructuredAgentSessionHostDeps, 'logger'> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getConversation'>
}

/** Keep personal unsent text as cards and mark reopen before close; quit leaves recovery to next open.
 * Partial-close rechecks mark only settled sends; failures report and return false. */
export async function holdClosedStructuredAgentSessionSends(
  deps: ConversationCloseDeps,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  close: {
    mark: 'always' | 'settled'
    select?: JournalSubmissionSelector
    unrun?: true | JournalSubmissionSelector
  },
  cause: UnsentSendHold['cause'] = 'chatClosed'
): Promise<boolean> {
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  const settled = await journal
    .write({
      kind: 'hold-unsent',
      fence,
      ...(close.unrun ? { unrun: close.unrun } : {}),
      hold: cause === 'chatClosed' ? { cause, select: close.select } : { cause }
    })
    .then((commit) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hold-unsent returns the settled newest sequence or writer failure.
      const result = commit.value as JournalWriterSettled<number | null>
      if ('failure' in result) {
        throw restoreJournalSqlFailure(result.failure)
      }
      return result.value
    })
    .then(
      (newest) => ({ ok: true, newest }),
      (error: unknown) => {
        deps.logger.warn('settling queued messages of a closed chat failed', {
          scope: 'queued-abandon',
          sessionId,
          error
        })
        return { ok: false, newest: null }
      }
    )
  if (close.mark === 'always') {
    await markStructuredQueueReopen(sessionId, journal, fence, deps.logger)
  } else if (settled.newest !== null) {
    // Start the mark at settled sends so a later wake-up send is not held.
    await markStructuredQueueReopen(sessionId, journal, fence, deps.logger, settled.newest + 1)
  }
  return settled.ok
}

/** Retry failed open recovery without handing over earlier-process sends; failures propagate. */
export async function holdRestartedStructuredAgentSessionSends(
  logger: StructuredAgentSessionHostDeps['logger'],
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  fence: number
): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hold-unsent returns the settled newest sequence or writer failure.
  const result = (
    await journal.write({ kind: 'hold-unsent', fence, hold: { cause: 'hostRestarted' } })
  ).value as JournalWriterSettled<number | null>
  if ('failure' in result) {
    throw restoreJournalSqlFailure(result.failure)
  }
  const settled = result.value
  if (settled !== null) {
    await markStructuredQueueReopen(sessionId, journal, fence, logger, settled + 1)
  }
}

/** Release only the restart pause still present at the writer position. */
export async function liftStructuredQueueRestartHold(
  journal: Pick<AgentSessionJournal, 'write'>,
  fence: number
): Promise<void> {
  await journal.write({ kind: 'queue-resume', fence, onlyRestarted: true })
}
