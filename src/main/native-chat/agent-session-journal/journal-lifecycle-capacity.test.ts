import { describe, expect, it } from 'vitest'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { JournalLifecycleCapacity } from './journal-lifecycle-capacity'

describe('JournalLifecycleCapacity', () => {
  it('enforces append-slot limits for both rebuilt submission reservations', () => {
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'session-1',
      cursor: { epoch: 'epoch-1', sequence: 1 },
      items: [],
      submissions: [
        {
          clientMessageId: 'message-1',
          fence: 0,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        }
      ]
    }

    const capacity = new JournalLifecycleCapacity()

    expect(capacity.rebuild(snapshot, Number.MAX_SAFE_INTEGER, 0, 1)).toBe(false)
    expect(capacity.reservedAppendSlots).toBe(1)
  })
})
