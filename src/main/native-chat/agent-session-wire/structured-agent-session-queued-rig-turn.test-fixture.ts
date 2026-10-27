import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'

/** Open the send’s turn; repeat with interrupted to end it. */
export async function openRigTurnFor(
  rig: QueuedMessageTestRig,
  id: string,
  state: 'running' | 'interrupted' = 'running'
): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(id),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() })
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

export async function withdrawnByStop(rig: QueuedMessageTestRig, id: string): Promise<void> {
  await rig.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: id,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  })
}
