import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// The lifetime of a provider child, against the real host rather than a double.
//
// Two leaks meet here: a chat that closes without stopping its app-server, and a launch that
// starts one for every record on disk. A view never starts or keeps a child; work starts one, the
// idle sweep stops it, and an exit is settled and left for the next send.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-projection'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { unexpectedProviderExitOutcome } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-feed'
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
/** Short enough to keep the suite fast; the host clock below decides what is idle. */
const SWEEP_MS = 5
const IDLE_MS = 1_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let sink: StructuredAgentSessionEventSink | null
let hostErrors: unknown[]
let statusSink: StructuredAgentSessionStatusSink
let clock: number
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
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: SWEEP_MS, idleMs: IDLE_MS },
    now: () => clock,
    onEventSinkError: ({ error }) => hostErrors.push(error),
    statusSink,
    ...(probeOwner ? { probeOwner } : {})
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

/** What a send's delivery or `agentSession.ensure` does: attach at the record's current fence. */
async function startAgent(): Promise<void> {
  const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
  expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })
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
    { kind: 'status', text: state, turnLifecycle: { turnId: 'turn-1', state } },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The sweep stops the child first and closes the conversation last. */
function waitForEviction(): Promise<void> {
  return vi.waitFor(() => {
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
  })
}

/** Long enough for many sweep ticks, so "not stopped" means the sweep declined. */
function waitOutSeveralSweeps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 20))
}

/** Fails the next eviction at `drain-published`, which leaves the session indexed for a retry. */
function failNextDrain(): void {
  vi.spyOn(host['runtimeState'].eventSinkFor(SESSION), 'drained').mockResolvedValueOnce({
    ok: false,
    error: new Error('drain barrier lost')
  })
}

/** The submissions as they stood when the session was forgotten; its journal is gone after that. */
async function failJournalSinkUntilReleased(): Promise<void> {
  const session = (
    host as unknown as {
      sessions: Map<string, { journal: { appendItem: (...args: never[]) => Promise<unknown> } }>
    }
  ).sessions.get(SESSION)
  expect(session).toBeDefined()
  vi.spyOn(session!.journal, 'appendItem').mockRejectedValueOnce(new Error('disk unavailable'))
  sink?.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'lost write' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await vi.waitFor(() => {
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed' }
    })
  })
}

/** Replaces the failed cached sink so suite cleanup can drain the host. */
function replaceFailedSink(): void {
  ;(
    host as unknown as {
      runtimeState: { eventSinkFor: (sessionId: string) => unknown }
    }
  ).runtimeState.eventSinkFor(SESSION)
}

function captureSettledSubmissions(): { value: AgentJournalSubmission[] } {
  const captured: { value: AgentJournalSubmission[] } = { value: [] }
  const journal = host['sessions'].get(SESSION)!.journal
  const closeJournal = journal.close.bind(journal)
  vi.spyOn(journal, 'close').mockImplementation(async () => {
    captured.value = journal.snapshot().submissions
    await closeJournal()
  })
  return captured
}

async function sendPending(text: string): Promise<void> {
  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const body = hostTestMessage(text)
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-surface-lifetime-'))
  resetHostTestOperationIds()
  sink = null
  hostErrors = []
  clock = NOW
  statusSink = { publish: vi.fn(), forget: vi.fn() }
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
  it('stops the provider child it started', async () => {
    await attach()

    await host.close(SESSION)

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
    expect(hostErrors).toEqual([])
    // The record and its journal stay; only the process and the claim on it go.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
  })

  // The pane outlives the close by a few frames — a workspace delete closes the chats inside it
  // while their panes are still mounted. A read in that window reopens the conversation as a cache
  // and is answered, never refused; it starts nothing.
  it('answers a read from the pane that outlived it without starting a child', async () => {
    await attach()

    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)

    expect((await host.history({ sessionId: SESSION, direction: 'tail' })).ok).toBe(true)
    const unsubscribe = await host.subscribe({
      id: 'sub-1',
      sessionId: SESSION,
      emit: () => undefined
    })
    unsubscribe()
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('answers a compatibility wait with what eviction recorded', async () => {
    await attach()
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('pending until close')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    expect(result).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    if (!result.ok) {
      throw new Error('send was refused')
    }
    // Handed over first: a message still queued at close is rejected as never sent instead.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    const settlement = host.waitForSendSettlement(SESSION, result.value.clientMessageId)

    await host.close(SESSION)

    // Eviction's settlement is a journal write, so the wait sees it rather than timing out.
    await expect(settlement).resolves.toMatchObject({
      value: {
        submission: { dispatchState: 'unknown', reason: 'provider_closed_before_acknowledgement' }
      }
    })
  })

  it('keeps the stop it made when the journal close loses its result', async () => {
    await attach()
    const session = host['sessions'].get(SESSION)
    expect(session).toBeDefined()
    const closeJournal = session!.journal.close.bind(session!.journal)
    vi.spyOn(session!.journal, 'close')
      .mockImplementationOnce(async () => {
        await closeJournal()
        throw new Error('journal close result lost')
      })
      .mockImplementation(closeJournal)

    // The child is stopped and the lease released before the handle closes; the entry is dropped
    // before that close, so a lost result leaves no closing handle for a reader to find.
    await expect(host.close(SESSION)).rejects.toThrow('journal close result lost')
    expect(host.hasSession(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })

    await expect(host.close(SESSION)).resolves.toBeUndefined()
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('settles and releases on the retry when a step after the child stopped aborts', async () => {
    await attach()
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('pending across an aborted eviction')
    const sent = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    const session = host['sessions'].get(SESSION)
    expect(session).toBeDefined()
    vi.spyOn(host['runtimeState'].eventSinkFor(SESSION), 'drained').mockResolvedValueOnce({
      ok: false,
      error: new Error('drain barrier lost')
    })
    const settled = captureSettledSubmissions()

    await expect(host.close(SESSION)).rejects.toMatchObject({ step: 'drain-published' })
    // The child is proven gone, but the wind-down it owes is not done: nothing settled, no release.
    expect(session!.child).toBeNull()
    expect(store.getRecord(SESSION)?.lease.claimStatus).not.toBe('released')

    await expect(host.close(SESSION)).resolves.toBeUndefined()
    expect(closeSession).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(hasUnansweredStructuredAgentSessionDispatch(settled.value)).toBe(false)
  })
})

describe('a session with a turn in flight', () => {
  it('is not stopped while the turn runs, and is once it ends and idles', async () => {
    await attach()
    emitTurnLifecycle('running', 1)
    await host.flushStreamedEvents(SESSION)

    clock += IDLE_MS
    await waitOutSeveralSweeps()

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)

    emitTurnLifecycle('completed', 2)
    await host.flushStreamedEvents(SESSION)
    clock += IDLE_MS

    await waitForEviction()
  })

  // Codex settles an admitted send only on its echo, which may never come; the stop retires it.
  it('is stopped with an admitted send outstanding once no turn runs', async () => {
    await attach()
    await sendPending('admitted, never echoed')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())

    clock += IDLE_MS

    await waitForEviction()
  })
})

describe('startup', () => {
  it('settles an idle absent owner without chat pollution and resumes the same provider identity', async () => {
    await attach()
    const beforeRestart = store.getRecord(SESSION)
    host['runtimeState'].stopLeaseRenewal()
    host['lifetime'].dispose()
    await host['sessions'].get(SESSION)?.journal.close()
    host['sessions'].clear()

    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    openHost(async () => ({ outcome: 'pid-absent' }))
    await host.restoreReadableSessions()

    const restored = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(restored.ok && restored.page.items.some((item) => item.body.kind === 'status')).toBe(
      false
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      settlementRetryRequired: undefined
    })

    await startAgent()
    expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toEqual(
      beforeRestart?.providerHandleChain.at(-1)?.handle
    )
    expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.origin).toBe('resumed')
  })

  it('restores a session for reading without spawning a provider child', async () => {
    await attach()
    await reboot()

    await host.restoreReadableSessions()

    // The record is readable — the tab comes back, history answers — and nothing is running.
    expect(acquire).not.toHaveBeenCalled()
    expect(host.listSessionTabs()).toEqual([
      { sessionId: SESSION, workspaceId: 'workspace-1', agent: 'codex' }
    ])
    expect((await host.history({ sessionId: SESSION, direction: 'tail' })).ok).toBe(true)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('gives the child back for work, never for a read', async () => {
    await attach()
    await reboot()
    await host.restoreReadableSessions()

    const unsubscribe = await host.subscribe({
      id: 'viewer-1',
      sessionId: SESSION,
      emit: () => undefined
    })
    expect(acquire).not.toHaveBeenCalled()
    await startAgent()
    unsubscribe()

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeKind: 'native',
      ownerProcess: { pid: 4242 }
    })
  })
})

describe('a session closed and started again', () => {
  it('publishes provider events to the reattached chat', async () => {
    await attach()
    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)

    await startAgent()
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'subscriber-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'back again' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    sink?.publish()
    await host.flushStreamedEvents(SESSION)
    unsubscribe()

    expect(JSON.stringify(events)).toContain('back again')
  })
})

async function submissionState(clientMessageId: string): Promise<string | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )?.dispatchState
}

describe('an unexpected provider exit', () => {
  it('publishes terminal settlement to a waiting older client', async () => {
    await attach()
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('pending until provider exit')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    expect(result).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    if (!result.ok) {
      throw new Error('send was refused')
    }
    // Accepted first; the exit must meet a message the provider was handed.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    const settlement = host.waitForSendSettlement(SESSION, result.value.clientMessageId)
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    await expect(settlement).resolves.toMatchObject({
      value: { submission: { dispatchState: 'unknown' } }
    })
  })

  it('turns a journal sink failure into observed-exit settlement and lease release', async () => {
    await attach()

    await failJournalSinkUntilReleased()

    expect(dispatch).not.toHaveBeenCalled()
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      history.ok &&
        history.page.items.some(
          (item) => item.body.kind === 'status' && item.body.text.includes('journal sink failure')
        )
    ).toBe(false)
    replaceFailedSink()
  })

  it('settles a journal sink failure whose stop saw the provider root exit', async () => {
    await attach()
    // The lease follows the root, so its seen exit settles like a proven one.
    closeSession.mockRejectedValueOnce(
      new AgentSessionAcquisitionRootExitObservedError(new Error('provider close unproven'))
    )

    await failJournalSinkUntilReleased()

    replaceFailedSink()
  })

  it('releases the exact generation, starts nothing, and the next message starts a child', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('provider delivery became unknown'))
    const unknownBody = hostTestMessage('message with unknown delivery')
    const unknownEnvelope = envelope('agentSession.send', { body: unknownBody })
    await expect(
      host.send(CALLER, { envelope: unknownEnvelope, body: unknownBody })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    // Accepted, then handed over by the delivery loop, where the thrown dispatch becomes doubt.
    await vi.waitFor(async () =>
      expect(await submissionState(unknownEnvelope.clientOperationId)).toBe('unknown')
    )
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })

    const recoveredHistory = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      recoveredHistory.ok &&
        hasUnansweredStructuredAgentSessionDispatch(recoveredHistory.page.submissions)
    ).toBe(false)
    // No respawn: the exit is settled and shown, and the conversation waits for work.
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: exitedFence + 1
    })
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-next', ordinal: 1 }
    })
    const body = hostTestMessage('a distinct next message')
    const nextEnvelope = envelope('agentSession.send', { body })
    await expect(host.send(CALLER, { envelope: nextEnvelope, body })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    await vi.waitFor(async () =>
      expect(await submissionState(nextEnvelope.clientOperationId)).toBe('accepted')
    )
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('does not reacquire for a live reader or a stale child generation', async () => {
    await attach()
    const unsubscribe = await host.subscribe({
      id: 'subscriber-1',
      sessionId: SESSION,
      emit: () => undefined
    })
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
    unsubscribe()
  })

  it('keeps a requested close out of recovery', async () => {
    await attach()
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
    dispatch.mockRejectedValueOnce(new Error('provider delivery became unknown'))
    const unknownBody = hostTestMessage('message with unknown delivery')
    const unknownParams = {
      envelope: envelope('agentSession.send', { body: unknownBody }),
      body: unknownBody
    }
    await expect(host.send(CALLER, unknownParams)).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    await vi.waitFor(async () =>
      expect(await submissionState(unknownParams.envelope.clientOperationId)).toBe('unknown')
    )
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
      claimStatus: 'released',
      runtimeFence: exitedFence + 1
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(hostErrors).toContainEqual(expect.objectContaining({ message: 'journal failed' }))
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.submissions[0]?.dispatchState).toBe('unknown')
    // A send whose delivery outcome is unknown IS work in progress, so the reassuring outcome is
    // written — carrying the cause, and never the old bare `Provider exited: <reason>` row.
    const statuses = history.ok
      ? history.page.items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
      : []
    expect(statuses).toEqual([unexpectedProviderExitOutcome('provider exited')])
    expect(statuses.some((text) => text.startsWith('Provider exited'))).toBe(false)

    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-next', ordinal: 1 }
    })
    const body = hostTestMessage('a distinct next message after failed-barrier recovery')
    const nextEnvelope = envelope('agentSession.send', { body })
    await expect(host.send(CALLER, { envelope: nextEnvelope, body })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    await vi.waitFor(async () =>
      expect(await submissionState(nextEnvelope.clientOperationId)).toBe('accepted')
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('latches a failed exit settlement and blocks attach until the terminal batch is written', async () => {
    await attach()
    emitTurnLifecycle('running', 1)
    await host.flushStreamedEvents(SESSION)
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

describe('a quit over an eviction that never got its retry', () => {
  // Nothing calls `close` a second time when the user quits instead of reopening the chat, so the
  // quit sweep is the last thing that can hand the lease back — and it only reaches the session if
  // it still counts a stopped child's unfinished wind-down as owed.
  it('finishes the wind-down the aborted close left behind', async () => {
    await attach()
    await sendPending('pending across an abandoned eviction')
    const settled = captureSettledSubmissions()
    failNextDrain()

    await expect(host.close(SESSION)).rejects.toMatchObject({ step: 'drain-published' })
    expect(host['sessions'].get(SESSION)?.child).toBeNull()
    expect(store.getRecord(SESSION)?.lease.claimStatus).not.toBe('released')

    await host.flushAllStreamedEvents()

    expect(closeSession).toHaveBeenCalledOnce()
    expect(host.hasSession(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(hasUnansweredStructuredAgentSessionDispatch(settled.value)).toBe(false)
  })
})
