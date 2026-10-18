import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  earlierStructuredAgentSessionSequence,
  markEarlierStructuredAgentSessionPending
} from './structured-agent-session-earlier-sends'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'

/** Give earlier sends their canonical meaning before publication; failed bookkeeping never refuses the open. */
export async function prepareStructuredAgentSessionOpen(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>,
  sessionId: string,
  journal: AgentSessionJournal,
  opened: AgentJournalCursor
): Promise<void> {
  const record = deps.store.getRecord(sessionId)
  if (!record || deps.store.readOnly) {
    return
  }
  const warn = (error: unknown) =>
    deps.logger.warn('recovering earlier messages at chat open did not finish', {
      scope: 'open-recovery',
      sessionId,
      error
    })
  const fence = record.lease.runtimeFence
  await markEarlierStructuredAgentSessionPending(journal, fence, opened).catch(warn)
  await holdUnsentSends(journal, {
    fence,
    hostInstance: structuredAgentSessionHostInstance(),
    hold: {
      cause: 'hostRestarted',
      which: (entry) =>
        earlierStructuredAgentSessionSequence(journal, opened, entry.acceptedSequence)
    }
  }).catch(warn)
  journal.holdReopenFromOpen()
}
