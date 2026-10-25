// Include the durable submission and dispatchState: ok alone proves no message delivery.

import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'

export function structuredSendResultFixture(
  dispatchState: AgentJournalDispatchState,
  reason: string | null = null
): AgentSessionSendResult {
  return {
    clientMessageId: 'msg-1',
    submission: {
      clientMessageId: 'msg-1',
      fence: 3,
      payloadFingerprint: 'fingerprint',
      dispatchState,
      providerItemId: null,
      reason,
      submittedAt: 10,
      resolvedAt: dispatchState === 'pending' ? null : 10
    }
  }
}
