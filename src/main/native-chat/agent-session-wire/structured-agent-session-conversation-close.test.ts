// Stopping an agent and closing its conversation's handle are two things, and a reader, a session
// list and a send each see only the one that happened. Ticks are driven by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { readStructuredSessionGateFacts } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  readerSaw,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  sweepOnce,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

function fence(): number {
  return rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
}

function openSession(): StructuredAgentSessionHostSession | undefined {
  const sessions: unknown = Reflect.get(rig.host, 'sessions')
  return sessions instanceof Map ? sessions.get(SESSION) : undefined
}

function statusRows(): AgentSessionStatusSummary[] {
  return rig.statusEvents
    .flatMap((event) => (event.type === 'status' ? [event.session] : []))
    .filter((summary) => summary.sessionId === SESSION)
}

describe('a stop that fails', () => {
  it('is retried on the next tick (P2-11 a)', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockResolvedValueOnce(false)
    rig.clock.now += IDLE_MS + 1

    await sweepOnce(rig.host)
    expect(openSession()?.owesProviderChildWindDown).toMatchObject({ generation: expect.any(String) })
    await sweepOnce(rig.host)

    expect(rig.adapter.closeSession).toHaveBeenCalledTimes(2)
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(statusRows().at(-1)?.hostExecutionOwned).toBeUndefined()
  })

  it('finishes its wind-down on the next tick, whatever its own writes did to the clock (P2-11 b)', async () => {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS + 1
    // The child is proven gone and its work settled, then handing the lease back fails.
    const transition = vi
      .spyOn(rig.store, 'transitionHandoff')
      .mockRejectedValueOnce(new Error('store unavailable'))

    await sweepOnce(rig.host)
    expect(transition).toHaveBeenCalledOnce()
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    // Five minutes later, not thirty.
    rig.clock.now += 5 * 60_000
    await sweepOnce(rig.host)

    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(rig.adapter.closeSession).toHaveBeenCalledOnce()
  })
})

describe('closing the handle', () => {
  it('keeps a tabbed chat listed and its reader open, and a send reopens it for that reader (P2-14)', async () => {
    await foundRestTestChat(rig)
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    rig.clock.now += IDLE_MS + 1

    await sweepOnce(rig.host)
    expect(rig.host.hasSession(SESSION)).toBe(false)
    // The row stays in the agent-status store, idle and no longer running here, and a session
    // list that connects now still gets it.
    expect(rig.sink.forget).not.toHaveBeenCalled()
    expect(rig.sink.publish.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: SESSION })
    expect(statusRows().at(-1)?.hostExecutionOwned).toBeUndefined()
    const late: { type: string; sessions?: AgentSessionStatusSummary[] }[] = []
    rig.host.subscribeStatus({ id: 'late', emit: (event) => late.push(event) })
    expect(late[0]?.sessions?.map((summary) => summary.sessionId)).toContain(SESSION)
    expect(reader.events.some((event) => event.type === 'end')).toBe(false)

    const sent = await rig.host.send(CALLER, restTestSend('after the close', fence()))
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    // The reader opened on the first handle is fed by the second.
    await vi.waitFor(() => expect(readerSaw(reader.events).texts).toContain('after the close'))
  })

  it('drops the agent-status row of a chat whose tab is gone (P2-14, retired)', async () => {
    await foundRestTestChat(rig)
    await rig.store.setSessionTabVisibility(SESSION, false)
    rig.clock.now += IDLE_MS + 1

    await sweepOnce(rig.host)
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(rig.sink.forget).toHaveBeenCalled()
  })

  it('forgets the row of a resting chat once its tab closes (P2-32)', async () => {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(rig.sink.forget).not.toHaveBeenCalled()

    await rig.host.setSessionTabVisibility(SESSION, false)
    expect(rig.sink.forget).toHaveBeenCalled()
  })

  it('keeps the row when a chat with an open tab is evicted, and forgets it once the tab closes', async () => {
    await foundRestTestChat(rig)

    await rig.host.close(SESSION)
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    // The stop says not-running; the row belongs to the tab, so nothing forgets it.
    expect(rig.sink.forget).not.toHaveBeenCalled()
    expect(rig.sink.publish.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: SESSION })
    expect(rig.sink.publish.mock.calls.at(-1)?.[0].hostExecutionOwned).toBeUndefined()

    await rig.host.setSessionTabVisibility(SESSION, false)
    expect(rig.sink.forget).toHaveBeenCalledOnce()
  })

  it('never hands a reader a handle it is closing (P2-25)', async () => {
    await foundRestTestChat(rig)
    const journal = openSession()?.journal
    if (!journal) {
      throw new Error('the conversation should be open')
    }
    const closing = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const close = journal.close.bind(journal)
    vi.spyOn(journal, 'close').mockImplementation(async () => {
      await close()
      closing.resolve()
      await gate.promise
    })
    rig.clock.now += IDLE_MS + 1
    const tick = sweepOnce(rig.host)
    await closing.promise

    const history = rig.host.history({ sessionId: SESSION, direction: 'tail' })
    const facts = readStructuredSessionGateFacts(SESSION)
    gate.resolve()
    await tick

    const page = await history
    expect(page.ok && page.page.items.length).toBeGreaterThan(0)
    await expect(facts).resolves.not.toBeNull()
    // And the handle a write finds is a live one.
    const sent = await rig.host.send(CALLER, restTestSend('after the close', fence()))
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
  })

  it('never re-enters the session lock: a send and a Stop right after still finish (P2-28)', async () => {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS + 1
    const tick = sweepOnce(rig.host)
    const within = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wedged')), 2_000))
      ])
    const sent = within(rig.host.send(CALLER, restTestSend('right after', fence())))

    await within(tick)
    expect(await sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    await expect(within(sweepOnce(rig.host))).resolves.toBeUndefined()
  })
})

describe('the sweep and the lease (P2-20)', () => {
  it('reads only open conversations and never probes or resolves a lease', async () => {
    await foundRestTestChat(rig)
    const probeOwner = vi.fn(async () => ({ outcome: 'pid-absent' as const }))
    await rig.restart({ probeOwner })
    setStructuredAgentSessionHost(rig.host)
    await rig.store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, handoffStage: 'recovering' }
    }))
    const resolveRecovery = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's private runtime state, spied to prove the sweep never resolves a lease.
      Reflect.get(rig.host, 'runtimeState') as {
        resolveRecovery: (id: string) => Promise<unknown>
      },
      'resolveRecovery'
    )
    // Open, at rest, on a lease still recovering.
    await rig.host.journalSnapshot(SESSION)
    expect(rig.host.hasSession(SESSION)).toBe(true)
    rig.clock.now += IDLE_MS + 1

    await sweepOnce(rig.host)
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(probeOwner).not.toHaveBeenCalled()
    expect(resolveRecovery).not.toHaveBeenCalled()
  })
})

describe('a start that never finishes (P2-15)', () => {
  it('is stopped by the sweep, its queued message rejected with why, and the chat still sends', async () => {
    const started = Promise.withResolvers<void>()
    rig.adapter.closeSession.mockImplementation(async () => {
      started.resolve()
      return true
    })
    const spawn = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementationOnce(async (input) => ({
      ...(await spawn(input)),
      providerChildPhase: 'starting' as const
    }))
    Object.assign(rig.host.deps.adapter, {
      awaitStarted: () => started.promise
    })
    const reader = collectSubscriber()
    const attached = await rig.host.attach(CALLER, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    const sent = await rig.host.send(CALLER, restTestSend('stuck behind the start', fence()))
    expect(sent.ok).toBe(true)
    rig.clock.now += IDLE_MS + 1

    await sweepOnce(rig.host)
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    await vi.waitFor(() =>
      expect(readerSaw(reader.events).submissions).toContainEqual(
        expect.objectContaining({
          dispatchState: 'rejected',
          reason: 'Codex never finished starting, so Orca stopped it.'
        })
      )
    )
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()

    const again = await rig.host.send(CALLER, restTestSend('try again', fence()))
    expect(again.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
    await expect(sweepOnce(rig.host)).resolves.toBeUndefined()
  })
})

describe('the wind-down retry with a message queued (P2-31)', () => {
  it('waits for the delivery rather than rejecting a message accepted after the failed stop', async () => {
    const queued = { clientMessageId: 'm', dispatchState: 'pending', handoverRecorded: true }
    const session = {
      journal: {
        submissions: () => [queued],
        pendingSubmissions: () => [queued],
        snapshot: () => ({ items: [] })
      },
      child: null,
      owesProviderChildWindDown: { generation: 'generation-1', fence: 1 }
    }
    const stopAgent = vi.fn(async () => undefined)
    const sweep = new StructuredAgentSessionIdleSweep({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a session fixture carrying only the journal and child facts the sweep reads.
      sessions: Object.assign(new Map([[SESSION, session as never]]), {
        lastActivityAt: () => 0
      }),
      serialize: (_id, task) => task(),
      now: () => IDLE_MS + 1,
      isDisposed: () => false,
      deliveryActive: () => true,
      backgroundTaskState: () => undefined,
      hasOpenDispatch: () => false,
      stopAgent,
      stopStartingAgent: stopAgent,
      closeConversation: vi.fn(async () => false),
      onError: (_id, error) => {
        throw error
      }
    })
    await sweep.tick()
    expect(stopAgent).not.toHaveBeenCalled()
  })
})
