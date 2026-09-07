// The lifetime of a provider child, from the surfaces that hold the session.
//
// Two leaks meet here and each has to be tested against the real host, not a double: a chat that
// closes without stopping its app-server, and a launch that starts one for every record on disk.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const SURFACE = 'desktop-chat:1'
/** Short enough to keep the suite fast, long enough that an eviction is a decision and not a race. */
const GRACE_MS = 5

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let sink: StructuredAgentSessionEventSink | null
let hostErrors: unknown[]
function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    closeSession,
    releaseAcquisition: vi.fn(async () => true),
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: false })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }
}

function openHost(
  probeOwner?: (record: never) => Promise<AgentSessionOwnerProbe>,
  handoffTransport?: StructuredAgentSessionHandoffTransport
): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    releaseGraceMs: GRACE_MS,
    now: () => NOW,
    onEventSinkError: ({ error }) => hostErrors.push(error),
    ...(probeOwner ? { probeOwner: probeOwner as never } : {}),
    ...(handoffTransport ? { handoffTransport } : {})
  })
}

/** A fresh app generation over the same durable store, with its owner proven gone. */
async function reboot(): Promise<void> {
  await host.flushAllStreamedEvents()
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost(async () => ({ outcome: 'pid-absent' }))
  acquire.mockClear()
  closeSession.mockClear()
}

async function attach(): Promise<void> {
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
}

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function emitTurnLifecycle(state: 'running' | 'completed', ordinal: number): void {
  sink?.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal },
    { kind: 'status', text: state, turnLifecycle: { turnId: 'turn-1', state } }
  )
}

/** Eviction is a sequence, not an event: the child stops first and the session is forgotten last. */
function waitForEviction(): Promise<void> {
  return vi.waitFor(() => {
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
  })
}

/** Long enough for several grace windows to elapse, so "not evicted" means the clock declined. */
function waitOutSeveralGraceWindows(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-surface-lifetime-'))
  resetHostTestOperationIds()
  sink = null
  hostErrors = []
  let generation = 0
  acquire = vi.fn(async ({ fence, spawnToken, events }) => {
    sink = events ?? null
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: `generation-${++generation}`,
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  closeSession = vi.fn(async () => true)
  dispatch = vi.fn(async () => ({ state: 'rejected' as const, reason: 'unused' }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a chat that closes', () => {
  it('releases the provider child it was holding', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)

    host.release(SESSION, SURFACE)

    await waitForEviction()
    expect(hostErrors).toEqual([])
    // The record and its journal stay; only the process and the claim on it go.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
  })

  it('keeps the child while another surface still holds the session', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    await host.hold(SESSION, 'paired-phone:1')

    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('does not lose the session to a release the client sent twice', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    await host.hold(SESSION, 'paired-phone:1')

    // A retried release must retire ONE holder, which is what a set gets right and a count does not.
    host.release(SESSION, SURFACE)
    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })
})

describe('a session with a turn in flight', () => {
  it('is not evicted while the turn runs, and is once it ends', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    emitTurnLifecycle('running', 1)
    await host.flushStreamedEvents(SESSION)

    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)

    emitTurnLifecycle('completed', 2)
    await host.flushStreamedEvents(SESSION)

    await waitForEviction()
  })
})

describe('startup', () => {
  it('restores a session for reading without spawning a provider child', async () => {
    await attach()
    await reboot()

    await host.restoreReadableSessions()

    // The record is readable — the tab comes back, history answers — and nothing is running.
    expect(acquire).not.toHaveBeenCalled()
    expect(host.listSessionTabs()).toEqual([
      { sessionId: SESSION, workspaceId: 'workspace-1', agent: 'codex' }
    ])
    expect(host.history({ sessionId: SESSION, direction: 'tail' }).ok).toBe(true)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('gives the child back to a chat a surface actually opens', async () => {
    await attach()
    await reboot()
    await host.restoreReadableSessions()

    await host.hold(SESSION, SURFACE)

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeKind: 'native',
      ownerProcess: { pid: 4242 }
    })
  })
})

describe('a session evicted and opened again', () => {
  it('publishes provider events to the reattached chat', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    host.release(SESSION, SURFACE)
    await waitForEviction()

    await host.hold(SESSION, 'desktop-chat:2')
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = host.subscribe({
      id: 'subscriber-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'back again' }] }
    )
    sink?.publish()
    await host.flushStreamedEvents(SESSION)
    unsubscribe()

    expect(JSON.stringify(events)).toContain('back again')
  })
})

describe('an unexpected provider exit', () => {
  it('turns a journal sink failure into observed-exit settlement and lease release', async () => {
    await attach()
    const session = (
      host as unknown as {
        sessions: Map<string, { journal: { appendItem: (...args: never[]) => Promise<unknown> } }>
      }
    ).sessions.get(SESSION)
    expect(session).toBeDefined()
    vi.spyOn(session!.journal, 'appendItem').mockRejectedValueOnce(new Error('disk unavailable'))

    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'lost write' }] }
    )

    await vi.waitFor(() => {
      expect(closeSession).toHaveBeenCalledWith(SESSION)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed' }
      })
    })
    expect(dispatch).not.toHaveBeenCalled()
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      history.ok &&
        history.page.items.some(
          (item) => item.body.kind === 'status' && item.body.text.includes('journal sink failure')
        )
    ).toBe(true)

    // Replace the failed cached sink so suite cleanup can drain the host.
    ;(
      host as unknown as {
        runtimeState: { eventSinkFor: (sessionId: string) => unknown }
      }
    ).runtimeState.eventSinkFor(SESSION)
  })

  it('releases the exact generation, reacquires outside the queue, and dispatches a new message', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    dispatch.mockRejectedValueOnce(new Error('provider delivery became unknown'))
    const unknownBody = hostTestMessage('message with unknown delivery')
    await expect(
      host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: unknownBody }),
        body: unknownBody
      })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: exitedFence + 2,
      ownerProcess: { pid: 4242 }
    })
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-next', ordinal: 1 }
    })
    const body = hostTestMessage('a distinct next message')
    await expect(
      host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('does not reacquire for a subscription-only hold or a stale child generation', async () => {
    await attach()
    await host.hold(SESSION, 'subscriber-1', { resume: false })
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'stale child exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-stale'
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'current child exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: exitedFence + 1,
      deathEvidence: { kind: 'exit-observed' }
    })
  })

  it('keeps a requested close out of recovery', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider closed',
      cause: 'requested-close',
      fence,
      acquisitionGeneration: 'generation-1'
    })

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('recovers after a failed lifecycle barrier and dispatches a distinct next message', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    dispatch.mockRejectedValueOnce(new Error('provider delivery became unknown'))
    const unknownBody = hostTestMessage('message with unknown delivery')
    const unknownParams = {
      envelope: envelope('agentSession.send', { body: unknownBody }),
      body: unknownBody
    }
    await expect(host.send(CALLER, unknownParams)).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    const runtimeState = (
      host as unknown as {
        runtimeState: { lifecycleBarrier: () => Promise<{ ok: false; error: Error }> }
      }
    ).runtimeState
    vi.spyOn(runtimeState, 'lifecycleBarrier').mockResolvedValueOnce({
      ok: false,
      error: new Error('journal failed')
    })
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: exitedFence + 2,
      ownerProcess: { pid: 4242 }
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(hostErrors).toContainEqual(expect.objectContaining({ message: 'journal failed' }))
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.submissions[0]?.dispatchState).toBe('unknown')
    expect(
      history.ok &&
        history.page.items.some(
          (item) =>
            item.body.kind === 'status' && item.body.text === 'Provider exited: provider exited'
        )
    ).toBe(true)

    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-next', ordinal: 1 }
    })
    const body = hostTestMessage('a distinct next message after failed-barrier recovery')
    await expect(
      host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('latches a failed exit settlement and blocks attach until the terminal batch is written', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)
    const runtimeState = (
      host as unknown as {
        runtimeState: { lifecycleBarrier: () => Promise<{ ok: false; error: Error }> }
      }
    ).runtimeState
    vi.spyOn(runtimeState, 'lifecycleBarrier').mockResolvedValueOnce({
      ok: false,
      error: new Error('journal failed')
    })
    const session = (
      host as unknown as {
        sessions: Map<
          string,
          { journal: { appendLifecycleBatch: (...args: never[]) => Promise<never> } }
        >
      }
    ).sessions.get(SESSION)
    expect(session).toBeDefined()
    const appendSettlement = vi
      .spyOn(session!.journal, 'appendLifecycleBatch')
      .mockRejectedValue(new Error('settlement still unavailable'))
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: 'recovering',
      settlementRetryRequired: true,
      settlementRetryId: `provider-exit:${SESSION}:${exitedFence}:generation-1`,
      ownerProcess: null,
      runtimeFence: exitedFence + 1
    })
    expect(await host.attach(CALLER, hostTestAttachParams(exitedFence + 1))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(acquire).toHaveBeenCalledOnce()

    appendSettlement.mockRestore()
    expect(await host.attach(CALLER, hostTestAttachParams(exitedFence + 1))).toMatchObject({
      ok: true
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      settlementRetryRequired: undefined
    })
    expect(acquire).toHaveBeenCalledTimes(2)
  })
})
