// The shape a real host answers `agentSession.send` with: the durable submission row
// IS the answer, and its `dispatchState` is the only thing that says whether the
// message landed. A fixture that omits it lets a client claim delivery from `ok`
// alone, which is the bug these tests exist to hold shut.

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
