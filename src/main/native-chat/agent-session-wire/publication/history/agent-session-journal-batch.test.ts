import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { projectJournalBatch } from './agent-session-journal-batch'

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

describe('journal batch for a writtenAt stamp', () => {
  // Subscribers already hold the message; only the submission changed.
  it('restates the submission without resending its unchanged message', () => {
    const projection = projectJournalBatch({
      rows: [
        {
          kind: 'outcome',
          epoch: 'e',
          seq: 5,
          itemIds: [],
          submissionIds: [],
          writtenSubmissionIds: ['c1']
        }
      ],
      snapshot: {
        sessionId: 'session',
        cursor: { epoch: 'e', sequence: 5 },
        items: [opener],
        submissions: [stamped]
      },
      afterSequence: 4
    })
    expect(projection).toEqual({
      ok: true,
      batch: {
        cursor: { epoch: 'e', sequence: 5 },
        items: [],
        removedItemIds: [],
        submissions: [stamped]
      }
    })
  })
})
