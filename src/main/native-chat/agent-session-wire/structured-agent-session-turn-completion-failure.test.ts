import { describe, expect, it } from 'vitest'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { readHostStatusState } from './structured-agent-session-host-status.test-fixture'
import { StructuredAgentSessionTurnCompletionFeed } from './observations/structured-agent-session-turn-completion-feed'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

const userEntry: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey('m1'),
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look into this' }] }
}

const submission = (fields: Partial<AgentJournalSubmission>): AgentJournalSubmission => ({
  clientMessageId: 'm1',
  fence: 1,
  payloadFingerprint: 'm1',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 10,
  resolvedAt: null,
  handoverRecorded: true,
  ...fields
})

// The host's own status read: the shared projection, then the failed request's typed reason.
function harness() {
  let items: AgentJournalRenderItem[] = []
  let submissions: AgentJournalSubmission[] = []
  let sequence = 0
  const journal = { cursor: () => ({ epoch: 'epoch-1', sequence }) }
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([['session-1', { journal, params: { location: LOCATION } }]]),
    readChildWork: () => undefined,
    now: () => 1_700,
    readStatusState: async () => readHostStatusState(items, submissions)
  })
  const events: AgentSessionTurnCompletionEvent[] = []
  feed.subscribe({ id: 'sub', emit: (event) => events.push(event) })
  return {
    events,
    set: async (nextItems: AgentJournalRenderItem[], nextSubmissions: AgentJournalSubmission[]) => {
      items = nextItems
      submissions = nextSubmissions
      sequence += 1
      await feed.observe('session-1')
    }
  }
}

describe('a failed request’s completion', () => {
  it('says why a send failed to start, typed, so its alert can say so', async () => {
    const h = harness()
    await h.set([], [])
    await h.set([userEntry], [submission({ handedOverAt: 11 })])
    const { reason, rejection } = agentSessionFailureWords(
      { kind: 'notSignedIn' },
      { surface: 'rejection' }
    )
    await h.set(
      [userEntry],
      [submission({ dispatchState: 'rejected', reason, rejection, resolvedAt: 20 })]
    )
    expect(h.events).toEqual([
      expect.objectContaining({
        completion: expect.objectContaining({
          outcome: 'failure',
          failure: { kind: 'notSignedIn' }
        })
      })
    ])
  })

  it('carries no reason for a request that succeeded', async () => {
    const h = harness()
    await h.set([], [])
    await h.set([userEntry], [submission({ handedOverAt: 11 })])
    await h.set(
      [
        userEntry,
        {
          itemId: 'codex:turn:t1',
          revision: 1,
          sequence: 2,
          observedAt: 2,
          body: { kind: 'turn', turnId: 't1', state: 'completed', outcome: 'success' }
        }
      ],
      [submission({ dispatchState: 'accepted', resolvedAt: 20 })]
    )
    expect(h.events).toEqual([
      expect.objectContaining({
        completion: expect.not.objectContaining({ failure: expect.anything() })
      })
    ])
  })
})
