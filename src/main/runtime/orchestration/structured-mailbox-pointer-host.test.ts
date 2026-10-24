import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'

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
    // The defect this pins: a running turn is announced by ONE lifecycle item, and settlement
    // tombstones it rather than rewriting it. A long tool-calling turn pushes that item arbitrarily
    // far from the tail, so any page-sized read reports a busy worker as idle — and `@idle` then
    // wakes it mid-turn.
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

  it('reads the journal epoch and host admission frontier without inferring a receiving turn', async () => {
    hostRef.current = {
      journalSnapshot: () => ({ cursor: { epoch: 'epoch' }, items: [], submissions: [] }),
      readMailHandoffEvidence: async () => ({ epoch: 'epoch', frontier: 'frontier' })
    }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toEqual({
      epoch: 'epoch',
      frontier: 'frontier'
    })
  })

  it('answers null rather than nothing recorded when the session cannot be read', async () => {
    // Null retains the pointer; an empty answer would send into a session this runtime cannot see.
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toBeNull()
    hostRef.current = {
      readMailHandoffEvidence: async () => {
        throw new Error('agent_session_ownership_unknown')
      }
    }
    expect(await createStructuredMailboxPointerHost().readSessionFacts('s1')).toBeNull()
  })

  it('reports an unattached host rather than a rejection when nothing can be sent', async () => {
    await expect(
      createStructuredMailboxPointerHost().send({
        beforeRun: () => true,
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    ).resolves.toEqual({ kind: 'unattached' })
  })

  it.each([
    ['accepted', 'accepted'],
    ['rejected', 'rejected'],
    // Neither is an acknowledgement, and only `accepted` may consume mail: both have to reach the
    // caller as `unknown` so the pointer is retained for the next journal edge.
    ['pending', 'unknown'],
    ['unknown', 'unknown']
  ])('maps a %s submission to %s', async (dispatchState, expected) => {
    const send = vi.fn(
      async (_caller: { callerKey: string }, _payload: { retryUnknown?: boolean }) => ({
        ok: true,
        value: { submission: { dispatchState } }
      })
    )
    hostRef.current = { send, waitForSendSettlement: async () => undefined }
    await expect(
      createStructuredMailboxPointerHost().send({
        beforeRun: () => true,
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    ).resolves.toEqual({ kind: 'sent', state: expected })
    // Per-dispatch caller key: names the dispatch the nudge is for.
    expect(send.mock.calls[0]![0]).toEqual({ callerKey: structuredPointerCallerKey('d1') })
    expect(send.mock.calls[0]![1]!.retryUnknown).toBeUndefined()
  })

  it('sends the pointer as a plain send for every agent, with who it is from', async () => {
    const send = vi.fn(
      async (_caller: unknown, _payload: { delivery?: string; body?: unknown }) => ({
        ok: true,
        value: { clientMessageId: 'op1', submission: { dispatchState: 'accepted' } }
      })
    )
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        beforeRun: () => true,
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [], from: NOTICE_SOURCE }
      })
    ).resolves.toMatchObject({ kind: 'sent', state: 'accepted' })
    expect(send.mock.calls[0]![1]).toMatchObject({ body: { from: NOTICE_SOURCE } })
    expect(send.mock.calls[0]![1]!.delivery).toBeUndefined()
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
        beforeRun: () => true,
        sessionId: 's1',
        dispatchId: 'd1',
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    ).resolves.toMatchObject({ kind: 'sent', state: 'accepted' })
  })

  it('scopes direct peer mail to the session when there is no dispatch to scope to', async () => {
    // Direct mail is addressed to the worker's own handle, so there may be no dispatch at all.
    // The ledger is keyed on (callerKey, operationId): a key derived from the session keeps that
    // nudge's own retry lane, and leaves the dispatch key byte-identical so nudges already in
    // flight under it still replay rather than being re-minted as a second turn.
    const send = vi.fn(async (_caller: { callerKey: string }) => ({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    }))
    hostRef.current = { send }
    await expect(
      createStructuredMailboxPointerHost().send({
        beforeRun: () => true,
        sessionId: 's1',
        dispatchId: null,
        operationId: 'op1',
        expectedRuntimeFence: 1,
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    ).resolves.toMatchObject({ kind: 'sent', state: 'accepted' })
    expect(send.mock.calls[0]![0]).toEqual({
      callerKey: structuredSessionPointerCallerKey('s1')
    })
    expect(structuredSessionPointerCallerKey('s1')).not.toBe(structuredPointerCallerKey('s1'))
  })

  it('separates a not-attached refusal from a real one', async () => {
    for (const [code, expected, details] of [
      ['agent_session_ownership_unknown', { kind: 'unattached' }, {}],
      ['agent_session_conflict', { kind: 'sent', state: 'rejected' }, {}],
      ['agent_session_operation_invalid', { kind: 'sent', state: 'rejected' }, undefined],
      [
        'agent_session_operation_invalid',
        { kind: 'held' },
        { reason: 'conversationCommandInFlight' }
      ]
    ] as const) {
      hostRef.current = {
        send: async () => ({ ok: false, refusal: { code, details, message: 'no' } })
      }
      await expect(
        createStructuredMailboxPointerHost().send({
          beforeRun: () => true,
          sessionId: 's1',
          dispatchId: 'd1',
          operationId: 'op1',
          expectedRuntimeFence: 1,
          body: { kind: 'message', role: 'user', blocks: [] }
        })
      ).resolves.toEqual(expected)
    }
  })

  it('reads the runtime fence off the durable record', () => {
    hostRef.current = { deps: { store: { getRecord: () => ({ lease: { runtimeFence: 9 } }) } } }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBe(9)
    hostRef.current = { deps: { store: { getRecord: () => null } } }
    expect(createStructuredMailboxPointerHost().currentFence('s1')).toBeNull()
  })
})
