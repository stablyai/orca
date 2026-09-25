// The idle sweep on a real host: what puts an agent to rest, what keeps it running, and what a
// reader and the session lists see when it does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  readerSaw,
  IDLE_MS,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  restTestSend,
  sweepTicks,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  await rig.dispose()
})

function providerEvents() {
  const events = rig.adapter.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no provider child was started')
  }
  return events
}

function lastStatus(): AgentSessionStatusSummary | undefined {
  return rig.statusEvents
    .flatMap((event) => (event.type === 'status' ? [event.session] : []))
    .findLast((summary) => summary.sessionId === SESSION)
}

function fence(): number {
  return rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
}

describe('the idle sweep', () => {
  it('stops an idle agent and keeps the conversation, its status row and its reader (P2-07)', async () => {
    await foundRestTestChat(rig)
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    rig.clock.now += IDLE_MS + 1

    await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
    await vi.waitFor(() => expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'))
    await vi.waitFor(() => expect(rig.adapter.acknowledgeSessionRelease).toHaveBeenCalledOnce())
    expect(rig.adapter.acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION)
    // Listed, idle, and no longer running on this host — never dropped from any list.
    expect(lastStatus()).toMatchObject({ status: 'idle' })
    expect(lastStatus()?.hostExecutionOwned).toBeUndefined()
    expect(rig.sink.forget).not.toHaveBeenCalled()
    expect(reader.events.some((event) => event.type === 'end')).toBe(false)

    // Everything a chat at rest answers still answers, and the next send starts a new agent.
    await expect(rig.host.readOptions(SESSION)).resolves.toMatchObject({ current: {} })
    const sent = await rig.host.send(CALLER, restTestSend('carry on', fence()))
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(readerSaw(reader.events).texts).toContain('carry on'))
  })

  it('never stops an agent a message is queued for, and hands the message over (P2-08)', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockClear()
    // The loop takes the message and waits on the child's start, outside the lock.
    const started = Promise.withResolvers<void>()
    const awaitStarted = vi.fn(() => started.promise)
    Object.assign(rig.host.deps.adapter, { awaitStarted })
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    const sent = await rig.host.send(CALLER, restTestSend('queued one', fence()))
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(awaitStarted).toHaveBeenCalled())
    rig.clock.now += IDLE_MS + 1

    await sweepTicks()
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    started.resolve()
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    const settled = (await rig.host.journalSnapshot(SESSION)).submissions.at(-1)
    expect(settled?.dispatchState).toBe('accepted')
    const seen = readerSaw(reader.events).submissions
    expect(seen.some((row) => row.dispatchState === 'accepted')).toBe(true)
    expect(
      seen.some((row) => row.dispatchState === 'rejected' || row.dispatchState === 'unknown')
    ).toBe(false)
  })

  it('never stops an agent whose background work still runs (P2-09)', async () => {
    await foundRestTestChat(rig)
    // A Codex subagent thread is one of these tasks; the tracker projects both kinds alike.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a background roster fixture; the sweep reads only whether live tasks exist.
    rig.adapter.backgroundTaskState.mockReturnValue({
      state: 'monitoring',
      tasks: [
        {
          taskId: 'subagent-1',
          kind: 'subagent',
          status: 'running',
          title: 'reviewer',
          startedAt: rig.clock.now
        }
      ]
    } as never)
    rig.clock.now += IDLE_MS + 1

    await sweepTicks()
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    rig.adapter.backgroundTaskState.mockReturnValue(undefined)
    await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
  })

  it('never stops an agent while its lead turn runs, however quiet (P2-10)', async () => {
    await foundRestTestChat(rig)
    providerEvents().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 50 },
      { kind: 'turn', turnId: 'working', state: 'running' }
    )
    await rig.host.flushStreamedEvents(SESSION)
    rig.clock.now += IDLE_MS + 1

    await sweepTicks()
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  })

  it('stops an agent whose chat is still open on screen (P2-12)', async () => {
    await foundRestTestChat(rig)
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'on-screen', sessionId: SESSION, emit: reader.emit })
    rig.clock.now += IDLE_MS + 1

    await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
    expect(reader.events.some((event) => event.type === 'end')).toBe(false)
  })

  it('counts the idle window from the last activity (P2-13)', async () => {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS - 60_000
    // Activity at 29 minutes: a provider row reaching the journal.
    providerEvents().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 60 },
      { kind: 'status', text: 'still thinking' }
    )
    await rig.host.flushStreamedEvents(SESSION)
    rig.clock.now += 60_001

    await sweepTicks()
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    rig.clock.now += IDLE_MS
    await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
  })

  it('never stops a worker whose orchestration dispatch is open, and stops it once it settles (P2-19 i)', async () => {
    await rig.dispose()
    let open = true
    const hasOpenDispatch = vi.fn(() => open)
    rig = await createRestTestRig({ hasOpenDispatch })
    await foundRestTestChat(rig)
    rig.clock.now += 2 * IDLE_MS

    await sweepTicks(12)
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(hasOpenDispatch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION }))
    open = false
    await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
  })

  it('keeps a child an unanswered prompt waits on (P2-22 i)', async () => {
    await foundRestTestChat(rig)
    providerEvents().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'subagent-turn', ordinal: 70 },
      {
        kind: 'approval',
        title: 'Run the command?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    )
    await rig.host.flushStreamedEvents(SESSION)
    rig.clock.now += IDLE_MS + 1

    await sweepTicks()
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  })
})

describe('the idle sweep with no child running (P2-22 ii)', () => {
  it('closes a handle whose only leftover is a prompt nobody can answer', async () => {
    const journal = {
      submissions: () => [],
      pendingSubmissions: () => [],
      snapshot: () => ({
        items: [
          {
            itemId: 'prompt',
            revision: 1,
            sequence: 1,
            observedAt: 0,
            body: {
              kind: 'approval',
              title: 'Run?',
              detail: null,
              options: [],
              resolution: {
                state: 'pending',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null
              }
            }
          }
        ]
      })
    }
    const sessions = Object.assign(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a session fixture carrying only the journal and child facts the sweep reads.
      new Map([[SESSION, { journal, child: null } as never]]),
      { lastActivityAt: () => 0 }
    )
    const stopAgent = vi.fn(async () => undefined)
    const closeConversation = vi.fn(async () => true)
    const sweep = new StructuredAgentSessionIdleSweep({
      sessions,
      serialize: (_id, task) => task(),
      now: () => IDLE_MS + 1,
      isDisposed: () => false,
      deliveryActive: () => false,
      backgroundTaskState: () => undefined,
      hasOpenDispatch: () => false,
      stopAgent,
      stopStartingAgent: stopAgent,
      closeConversation,
      onError: (_id, error) => {
        throw error
      }
    })
    await sweep.tick()
    expect(stopAgent).not.toHaveBeenCalled()
    expect(closeConversation).toHaveBeenCalledWith(SESSION)
  })
})
