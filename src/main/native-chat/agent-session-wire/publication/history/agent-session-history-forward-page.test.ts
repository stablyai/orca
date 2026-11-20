import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionForwardHistory } from './agent-session-history-forward-page'
import { measureHistoryItem } from './agent-session-history-page-bounds'

const opener: AgentJournalRenderItem = {
  itemId: 'orca:c1',
  revision: 0,
  sequence: 4,
  observedAt: 1_000,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'a long prompt' }] }
}
const stamped: AgentJournalSubmission = {
  clientMessageId: 'c1',
  fence: 1,
  payloadFingerprint: 'f',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1_000,
  resolvedAt: null,
  handedOverAt: 1_010,
  writtenAt: 1_020
}
const snapshot: AgentJournalSnapshot = {
  sessionId: 'session',
  cursor: { epoch: 'e', sequence: 5 },
  items: [opener],
  submissions: [stamped]
}

describe('forward history after a writtenAt stamp', () => {
  // Subscribers already hold the message; only the submission changed.
  it('delivers the stamped submission without resending its unchanged message', () => {
    const result = readAgentSessionForwardHistory(
      {
        readSince: () => ({
          ok: true,
          cursor: { epoch: 'e', sequence: 5 },
          through: 5,
          rows: [
            {
              kind: 'outcome',
              epoch: 'e',
              seq: 5,
              itemIds: [],
              submissionIds: [],
              writtenSubmissionIds: ['c1']
            }
          ]
        }),
        canonicalItemId: (itemId) => itemId,
        hasSubmission: () => true,
        reset: () => {
          throw new Error('unexpected reset')
        }
      },
      snapshot,
      { epoch: 'e', sequence: 4 },
      10,
      { form: measureHistoryItem, budgetBytes: 1_000_000 },
      () => snapshot
    )
    expect(result.ok && result.page.items).toEqual([])
    expect(result.ok && result.page.submissions).toEqual([stamped])
  })
})
