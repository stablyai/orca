import { sessionCrewChanges } from './crew/crew-changes'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
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

  it("passes on the chat host's own answer, never deciding it here", async () => {
    const answer = { kind: 'rejected', cancelled: false, recovered: true }
    const sendAnswer = vi.fn(async () => answer)
    hostRef.current = { sendAnswer }
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toBe(answer)
    expect(sendAnswer).toHaveBeenCalledWith('s1', 'op1')
  })

  it('reads an unreadable session as unreadable, never as nothing recorded', async () => {
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toEqual({
      kind: 'unreadable'
    })
    hostRef.current = {
      sendAnswer: async () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await createStructuredMailboxPointerHost().observe('s1', 'op1')).toEqual({
      kind: 'unreadable'
    })
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
          stillOwed: () => true,
          createdAt: 0
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
        stillOwed: () => true,
        createdAt: 0
      })
    ).resolves.toEqual({ kind: 'queued' })
    expect(send.mock.calls[0]![1]).toMatchObject({
      body: { from: NOTICE_SOURCE },
      delivery: 'queue-if-active'
    })
  })

  it("holds mail written by the person's Stop, the same second included, and lets later mail go", async () => {
    const stop = { reason: 'user-stop' as const, at: 1_700_000_000_900 }
    // The chat's write lane asks the admission with the Stop in force.
    hostRef.current = {
      send: async (_caller: unknown, payload: { admit: (stop: unknown) => void }) => {
        payload.admit(stop)
        return {
          ok: true,
          value: { clientMessageId: 'op1', submission: { dispatchState: 'accepted' } }
        }
      }
    }
    const send = (createdAt: number) =>
      createStructuredMailboxPointerHost().send({
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [], from: NOTICE_SOURCE },
        stillOwed: () => true,
        createdAt
      })
    expect(await send(1_699_999_999)).toEqual({ kind: 'held' })
    expect(await send(1_700_000_000)).toEqual({ kind: 'held' })
    expect(await send(Number.NaN)).toEqual({ kind: 'held' })
    expect(await send(1_700_000_001)).toEqual({ kind: 'sent', state: 'accepted' })
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

  it('opens a swept chat at rest to read its committed Stop, without a timeline read', async () => {
    let open = false
    const openQueueStop = vi.fn(async () => {
      open = true
    })
    const snapshot = vi.fn()
    hostRef.current = {
      deps: { store: { getConversation: () => ({ currentFence: 9 }) } },
      reads: {
        openQueueStop,
        readQueueStop: () =>
          open
            ? {
                epoch: 'epoch1',
                stopSequence: 3,
                stopAt: 1000,
                resumedSequence: 0,
                clearedSequence: 0
              }
            : undefined
      },
      journalSnapshot: snapshot
    }
    const adapter = createStructuredMailboxPointerHost()
    expect(adapter.readEligibility('s1')).toBeNull()
    expect(await adapter.openEligibility('s1')).toMatchObject({ fence: 9, stopAt: 1000 })
    expect(openQueueStop).toHaveBeenCalledWith('s1')
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('rebinds an absent or replaced host and cancels stale subscriptions', () => {
    const wake = vi.fn()
    const stop = createStructuredMailboxPointerHost().watchJournal('s1', wake)
    const unwatch = vi.fn()
    const observeJournalPublications = vi.fn(() => unwatch)
    hostRef.current = { observeJournalPublications }
    sessionCrewChanges.notify()
    expect(observeJournalPublications).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledTimes(1)
    sessionCrewChanges.notify()
    expect(wake).toHaveBeenCalledTimes(1)
    hostRef.current = null
    sessionCrewChanges.notify()
    expect(unwatch).toHaveBeenCalledTimes(1)
    stop()
    sessionCrewChanges.notify()
    expect(wake).toHaveBeenCalledTimes(2)
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
