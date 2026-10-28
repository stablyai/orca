import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { latestJournalDispatchObservation } from './journal-dispatch-observation'

describe('latestJournalDispatchObservation', () => {
  it('uses the newest submission in the requested fence', () => {
    const submissions = [
      {
        clientMessageId: 'unknown-7',
        fence: 7,
        payloadFingerprint: 'unknown-7',
        dispatchState: 'unknown' as const,
        recovered: true as const,
        providerItemId: null,
        reason: null,
        resolvedAt: null,
        submittedAt: 1
      },
      {
        clientMessageId: 'pending-8',
        fence: 8,
        payloadFingerprint: 'pending-8',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        resolvedAt: null,
        submittedAt: 2
      },
      {
        clientMessageId: 'pending-7',
        fence: 7,
        payloadFingerprint: 'pending-7',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        resolvedAt: null,
        submittedAt: 2
      },
      {
        clientMessageId: 'accepted-7',
        fence: 7,
        payloadFingerprint: 'accepted-7',
        dispatchState: 'accepted' as const,
        providerItemId: 'item-7',
        reason: null,
        resolvedAt: 3,
        submittedAt: 4
      }
    ] satisfies AgentJournalSubmission[]
    const journal = { submissions: () => submissions }

    expect(latestJournalDispatchObservation(journal, 7)).toEqual({
      state: 'accepted',
      recovered: false
    })
    expect(latestJournalDispatchObservation(journal, 8)).toEqual({
      state: 'pending',
      recovered: false
    })
  })

  it('returns no observation when the fence has no submission', () => {
    expect(latestJournalDispatchObservation({ submissions: () => [] }, 7)).toBeNull()
  })
})
