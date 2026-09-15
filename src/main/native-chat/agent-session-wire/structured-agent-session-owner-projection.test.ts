import { describe, expect, it } from 'vitest'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { projectStructuredAgentSessionOwnerPage } from './structured-agent-session-owner-projection'

const cursor = { epoch: 'epoch-1', sequence: 5 }

function page(): AgentSessionHistoryPage {
  return {
    sessionId: 'session-alpha-1',
    epoch: cursor.epoch,
    direction: 'tail',
    items: [
      {
        itemId: 'old-turn',
        ownerFence: 7,
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: 'old', state: 'running' }
      },
      {
        itemId: 'old-prompt',
        ownerFence: 7,
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'approval',
          title: 'Old approval',
          detail: null,
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      },
      {
        itemId: 'new-turn',
        ownerFence: 9,
        revision: 1,
        sequence: 3,
        observedAt: 3,
        body: { kind: 'turn', turnId: 'new', state: 'running' }
      },
      {
        itemId: 'new-prompt',
        ownerFence: 9,
        revision: 1,
        sequence: 4,
        observedAt: 4,
        body: {
          kind: 'question',
          question: 'New question',
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    ],
    submissions: [7, 9].map((fence) => ({
      clientMessageId: `send-${fence}`,
      fence,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    })),
    removedItemIds: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false
  }
}

describe('host owner projection for old paired clients', () => {
  it('makes an unsettled prior owner inert without ending the live child', () => {
    const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 9 }))
    const result = projectStructuredAgentSessionOwnerPage(page(), record)
    expect(result.items.map((item) => item.body)).toMatchObject([
      { kind: 'turn', state: 'unverifiable' },
      { kind: 'approval', resolution: { state: 'cancelled' } },
      { kind: 'turn', state: 'running' },
      { kind: 'question', resolution: { state: 'pending' } }
    ])
    expect(
      result.submissions.map((submission) => [submission.dispatchState, submission.recovered])
    ).toEqual([
      ['unknown', true],
      ['pending', undefined]
    ])
  })

  it('treats transcript import at a released fence as inert', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeFence: 9,
        claimStatus: 'released',
        ownerProcess: null
      })
    )
    const result = projectStructuredAgentSessionOwnerPage(page(), record)
    expect(result.items.at(-1)?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(result.items[2]?.body).toMatchObject({ state: 'unverifiable' })
    expect(result.submissions.every((submission) => submission.recovered === true)).toBe(true)
  })

  it('does not apply the latest witnessed exit to an earlier failed generation', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeFence: 9,
        settlementRetryRequired: true,
        settlementRetryFence: 8,
        settlementRetryId: 'second-exit',
        deathEvidence: { kind: 'exit-observed', observedAt: 200, detail: 'provider exited' }
      })
    )
    const current = page()
    current.items.splice(1, 1, {
      itemId: 'second-turn',
      ownerFence: 8,
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'second', state: 'running' }
    })
    const result = projectStructuredAgentSessionOwnerPage(current, record)
    expect(result.items.map((item) => item.body)).toMatchObject([
      { state: 'unverifiable' },
      { state: 'interrupted', completedAt: 200 },
      { state: 'running' },
      { resolution: { state: 'pending' } }
    ])
  })

  it('lets a later durable revision replace a projected fallback', () => {
    const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 9 }))
    const projected = projectStructuredAgentSessionOwnerPage(page(), record)
    const synthetic = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: projected
    })
    const durable = reduceStructuredAgentSession(synthetic, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: projected.sessionId,
        fence: 9,
        hostNow: 300,
        batch: {
          cursor: { epoch: projected.epoch, sequence: 6 },
          removedItemIds: [],
          submissions: [],
          items: [
            {
              ...projected.items[0]!,
              revision: 2,
              body: { kind: 'turn', turnId: 'old', state: 'interrupted', completedAt: 200 }
            }
          ]
        }
      }
    })
    expect(durable.items[0]?.body).toMatchObject({ state: 'interrupted', completedAt: 200 })
  })
})
