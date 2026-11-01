import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const {
  createStructuredMailboxPointerHost,
  readStructuredSessionGateFacts,
  structuredPointerCallerKey,
  structuredSessionPointerCallerKey
} = await import('./structured-mailbox-pointer-host')

function runningTurn(): AgentJournalRenderItem {
  return {
    itemId: 'lifecycle-1',
    revision: 1,
    body: { kind: 'status', text: 'working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  } as unknown as AgentJournalRenderItem
}

function transcript(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        revision: 1,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

function pointerSubmission(
  clientMessageId: string,
  fence: number,
  acceptedSequence: number
): AgentJournalSubmission {
  return {
    clientMessageId,
    acceptedSequence,
    submittedAt: 1_000,
    fence,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    resolvedAt: null
  }
}

const NOTICE_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'dispatch:d1', dispatchId: 'd1', messages: [] }
}

describe('structured mailbox pointer host', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('reads the gate facts from the FULL timeline, never a bounded tail', async () => {
    // Read the full timeline: a busy turn's lifecycle item may be far from the tail, and false idle can interrupt it.
    const items = [runningTurn(), ...transcript(500)]
    hostRef.current = {
      journalSnapshot: () => ({ items, submissions: [] }),
      currentWork: () => null
    }
    expect(await readStructuredSessionGateFacts('s1')).toEqual({
      turnRunning: true,
      awaitingHuman: false
    })
  })

  it.each([
    [
      'a waiting card',
      { clientMessageId: 'op1', queued: { state: 'waiting' } },
      undefined,
      'waiting'
    ],
    [
      'a deleted card',
      { clientMessageId: 'op1', queued: { state: 'withdrawn' } },
      undefined,
      'handed'
    ],
    [
      "a card's accepted handoff",
      { clientMessageId: 'op1', submission: { dispatchState: 'accepted' } },
      undefined,
      'handed'
    ],
    [
      "a card's rejected handoff",
      { clientMessageId: 'op1', submission: { dispatchState: 'rejected' } },
      undefined,
      'lost'
    ],
    ['a pending immediate send', null, 'pending', 'waiting'],
    ['an unanswered immediate send', null, 'unknown', 'lost'],
    ['nothing recorded', null, undefined, 'absent']
  ] as const)('reads %s without replaying the send', async (_label, answer, sent, expected) => {
    hostRef.current = {
      queuedSendAnswer: async () => answer,
      journalSnapshot: async () => ({
        items: [],
        submissions: sent ? [{ ...pointerSubmission('op1', 1, 1), dispatchState: sent }] : []
      })
    }
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toBe(expected)
  })

  it('reads an unreadable session as unreadable, never as nothing recorded', async () => {
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toBe('unreadable')
    hostRef.current = {
      queuedSendAnswer: async () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toBe('unreadable')
  })

  it('reports an unattached host rather than a rejection when nothing can be sent', async () => {
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'unattached' })
  })

  it.each(['accepted', 'pending', 'rejected', 'unknown'] as const)(
    'reports a %s send as is',
    async (dispatchState) => {
      const send = vi.fn(
        async (_caller: { callerKey: string }, _payload: { retryUnknown?: boolean }) => ({
          ok: true,
          value: { submission: { dispatchState } }
        })
      )
      hostRef.current = { send, waitForSendSettlement: async () => undefined }
      await expect(
        createStructuredMailboxPointerHost().send({
          sessionId: 's1',
          dispatchId: 'd1',
          operationId: 'op1',
          expectedRuntimeFence: 1,
          body: { kind: 'message', role: 'user', blocks: [] },
          stillOwed: () => true
        })
      ).resolves.toEqual({ kind: 'sent', state: dispatchState })
      expect(send.mock.calls[0]![0]).toEqual({ callerKey: structuredPointerCallerKey('d1') })
      expect(send.mock.calls[0]![1]!.retryUnknown).toBeUndefined()
    }
  )

  it("sends mail the way the chat's queue takes a person's message, with who it is from", async () => {
    const send = vi.fn(
      async (_caller: unknown, _payload: { delivery?: string; body?: unknown }) => ({
        ok: true,
        value: {
          clientMessageId: 'op1',
          queued: { messageId: 'op1', position: 0, state: 'waiting' }
        }
      })
    )
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [], from: NOTICE_SOURCE },
        stillOwed: () => true
      })
    ).resolves.toEqual({ kind: 'queued' })
    expect(send.mock.calls[0]![1]).toMatchObject({
      body: { from: NOTICE_SOURCE },
      delivery: 'queue-if-active'
    })
  })

  it('consumes mail once an accepted nudge is delivered while the worker starts (W10)', async () => {
    hostRef.current = {
      send: async () => ({
        ok: true,
        value: { clientMessageId: 'op1', submission: { dispatchState: 'pending' } }
      }),
      waitForSendSettlement: async () => ({
        value: { clientMessageId: 'op1', submission: { dispatchState: 'accepted' } }
      })
    }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: 'accepted' })
  })

  it('scopes direct peer mail to the session when there is no dispatch to scope to', async () => {
    // Direct mail has no Dispatch; a session-scoped key preserves its retry lane without changing existing Dispatch ledger keys.
    const send = vi.fn(async (_caller: { callerKey: string }) => ({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    }))
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: null,
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      } as never)
    ).resolves.toEqual({ kind: 'sent', state: 'accepted' })
    expect(send.mock.calls[0]![0]).toEqual({
      callerKey: structuredSessionPointerCallerKey('s1')
    })
    expect(structuredSessionPointerCallerKey('s1')).not.toBe(structuredPointerCallerKey('s1'))
  })

  it('separates a not-attached refusal from a real one', async () => {
    for (const [code, expected] of [
      ['agent_session_ownership_unknown', { kind: 'unattached' }],
      ['agent_session_conflict', { kind: 'refused' }]
    ] as const) {
      hostRef.current = { send: async () => ({ ok: false, refusal: { code, message: 'no' } }) }
      await expect(
        createStructuredMailboxPointerHost().send({
          sessionId: 's1',
          dispatchId: 'd1',
          operationId: 'op1',
          expectedRuntimeFence: 1,
          body: { kind: 'message', role: 'user', blocks: [] }
        } as never)
      ).resolves.toEqual(expected)
    }
  })

  it('reads the runtime fence off the durable record', () => {
    hostRef.current = {
      deps: {
        store: {
          getConversation: () =>
            agentSessionConversationView(
              agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 9 }))
            )
        }
      }
    }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBe(9)
    hostRef.current = { deps: { store: { getConversation: () => null } } }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBeNull()
  })
})
