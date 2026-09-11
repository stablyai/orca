// When a second send is allowed to reach the provider.
//
// The host serializes mutations only until the adapter call returns, which is
// long before the turn it started ends. A second send inside that window is
// coalesced by the provider into the running turn, so the journal records two
// ordered turns that were never run as two.

import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnLifecycleState } from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  ensureParams,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let events: StructuredAgentSessionEventSink | undefined

beforeEach(() => {
  ;({ root, store, host, acquire, dispatch } = hostTestState())
  events = undefined
  const spawn = acquire.getMockImplementation()
  acquire.mockImplementation(async (input) => {
    events = input.events
    return spawn!(input)
  })
})

/** The provider's own turn record, written through the sink it was handed. */
async function turnRecord(state: AgentJournalTurnLifecycleState, turnId = 'turn-1'): Promise<void> {
  const sink = events
  if (!sink) {
    throw new Error('the adapter was never handed an event sink')
  }
  sink.appendItem(
    {
      provider: 'legacy',
      agent: 'codex',
      sessionId: SESSION,
      recordId: `turn-lifecycle:${turnId}`
    },
    agentJournalTurnBody({ turnId, state })
  )
  sink.publish()
  await host.flushStreamedEvents(SESSION)
}

async function send(text: string): Promise<void> {
  const body = hostTestMessage(text)
  const result = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body
  })
  expect(result.ok).toBe(true)
}

function dispatchedTexts(): string[] {
  return dispatch.mock.calls.map((call) => {
    const block = call[0].body.blocks[0]
    return block?.type === 'text' ? block.text : ''
  })
}

describe('send behind a running turn', () => {
  it('holds the second send until the first turn reaches a terminal event', async () => {
    await attach()
    await send('first')
    await turnRecord('running')

    await send('second')

    // The submission is durable and pending; only the dispatch waits.
    expect(dispatchedTexts()).toEqual(['first'])
    expect(host.journalSnapshot(SESSION).submissions.map((entry) => entry.dispatchState)).toEqual([
      'accepted',
      'pending'
    ])

    await turnRecord('completed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))

    // Provider dispatch order matches journal order, one turn each.
    expect(dispatchedTexts()).toEqual(['first', 'second'])
    expect(host.journalSnapshot(SESSION).submissions.map((entry) => entry.dispatchState)).toEqual([
      'accepted',
      'accepted'
    ])
  })

  it('releases one held send per turn that ends, never the whole queue at once', async () => {
    await attach()
    await send('first')
    await turnRecord('running')
    await send('second')
    await send('third')

    await turnRecord('completed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatchedTexts()).toEqual(['first', 'second'])

    await turnRecord('running', 'turn-2')
    await turnRecord('completed', 'turn-2')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(dispatchedTexts()).toEqual(['first', 'second', 'third'])
  })

  it('still dedupes a replayed send with the same id and fingerprint', async () => {
    await attach()
    await send('first')
    await turnRecord('running')

    const body = hostTestMessage('second')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    const first = await host.send(CALLER, params)
    const replay = await host.send(CALLER, params)

    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(replay).toMatchObject({ ok: true, replayed: true })
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(2)
    expect(dispatchedTexts()).toEqual(['first'])
  })

  it('refuses a second send that reuses one message id for different content', async () => {
    await attach()
    await send('first')
    await turnRecord('running')

    const body = hostTestMessage('second')
    const reused = envelope('agentSession.send', { body })
    await host.send(CALLER, { envelope: reused, body })
    const other = hostTestMessage('a different message')
    const conflict = await host.send(CALLER, {
      envelope: {
        ...reused,
        payloadFingerprint: envelope('agentSession.send', { body: other }).payloadFingerprint
      },
      body: other
    })

    expect(conflict).toMatchObject({ ok: false })
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(2)
  })
})

describe('a host restart while a send is held', () => {
  /** The same directories under a new store and host — the state a crash leaves.
   *  Every lease loads unreconciled, so the reattach pays the stale-fence round
   *  trip a real client pays. */
  async function rebootAndReattach(heldFence: number): Promise<void> {
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW
    })
    replaceHostTestState({ store, host })
    dispatch.mockClear()
    const stale = await host.attach(CALLER, ensureParams(heldFence))
    expect(stale.ok).toBe(false)
    const current = stale.ok ? heldFence : (stale.refusal.currentFence ?? heldFence)
    expect(await host.attach(CALLER, ensureParams(current))).toMatchObject({ ok: true })
  }

  it('dispatches a held send exactly once instead of reporting it unconfirmed', async () => {
    const record = await attach()
    await send('first')
    await turnRecord('running')
    await send('held')
    expect(dispatch).toHaveBeenCalledTimes(1)

    await rebootAndReattach(record?.lease.runtimeFence ?? 0)

    await vi.waitFor(() =>
      expect(host.journalSnapshot(SESSION).submissions.map((entry) => entry.dispatchState)).toEqual(
        ['accepted', 'accepted']
      )
    )
    expect(dispatchedTexts()).toEqual(['held'])
    expect(
      host.journalSnapshot(SESSION).submissions.every((entry) => entry.queued === undefined)
    ).toBe(true)

    // Later publications must not put the same message on the wire again.
    await turnRecord('running', 'turn-2')
    await turnRecord('completed', 'turn-2')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })
})
