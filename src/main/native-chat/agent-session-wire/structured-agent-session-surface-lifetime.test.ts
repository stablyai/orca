// The lifetime of a provider child, from the surfaces that hold the session.
//
// Two leaks meet here and each has to be tested against the real host, not a double: a chat that
// closes without stopping its app-server, and a launch that starts one for every record on disk.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-projection'
import {
  activeStructuredAgentSessionTurnId,
  liveStructuredAgentSessionItems
} from '../../../shared/structured-agent-session-projection'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AGENT_SESSION_UNATTACHED_REFUSAL_CODE } from '../../../shared/structured-agent-session-read-refusal'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'
import { StructuredHandoffTestRequests } from './structured-agent-session-handoff-test-requests'
import { unexpectedProviderExitOutcome } from './structured-agent-session-dead-generation-settlement'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
let statusSink: StructuredAgentSessionStatusSink
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
    statusSink,
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

const handoffRequests = new StructuredHandoffTestRequests(
  NOW,
  SESSION,
  () => store.getRecord(SESSION)?.lease.runtimeFence ?? 0
)
/** Whether the terminal this host handed the session to can be reached again. */
let tuiRecoverable: boolean

/** One operation-id source with the rest of the suite, so the durable ledger sees no duplicate. */
function handoffRequest(direction: 'to-tui' | 'to-native') {
  return handoffRequests.request(direction, 'now', { operationId: hostTestOperationId() })
}

function tuiOwner(fence: number, spawnToken: string, transcriptPath: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui', ptyId: 'pty-tui' },
    process: { hostId: 'local', pid: 5200, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `tui-link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    },
    transcriptPath
  }
}

/** A codex rollout the return trip can import, so a real to-native handoff has history to read. */
async function writeTuiTranscript(): Promise<string> {
  const sessionsDir = join(root, 'codex-home', 'sessions', '2026', '08', '12')
  await mkdir(sessionsDir, { recursive: true })
  const transcriptPath = join(sessionsDir, `rollout-2026-08-12T10-00-00-${THREAD}.jsonl`)
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-12T10:00:00.000Z',
      payload: { id: THREAD, session_id: THREAD }
    })}\n`,
    'utf8'
  )
  return transcriptPath
}

/** Replaces the current host with one that can hand the session to a terminal and take it back. */
function openHandoffHost(transcriptPath: string): void {
  openHost(undefined, {
    hostLabel: 'Test host',
    launchTui: async ({ fence, spawnToken }) => tuiOwner(fence, spawnToken, transcriptPath),
    reproveTuiOwner: async ({ owner }) => owner,
    recoverTuiOwner: async (record) => {
      if (!tuiRecoverable) {
        throw new Error('the owning terminal could not be reached')
      }
      return tuiOwner(
        record.lease.runtimeFence,
        record.lease.reservedSpawnToken ?? 'recovered',
        transcriptPath
      )
    },
    stopRecoveredOwner: async () => undefined,
    closeTuiOwner: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiExit: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle'
  })
}

/** Fails the next eviction at `drain-published`, which leaves the session indexed for a retry. */
function failNextDrain(): void {
  vi.spyOn(host['runtimeState'].eventSinkFor(SESSION), 'drained').mockResolvedValueOnce({
    ok: false,
    error: new Error('drain barrier lost')
  })
}

/** The submissions as they stood when the session was forgotten; its journal is gone after that. */
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
  handoffRequests.reset()
  tuiRecoverable = true
  resetHostTestOperationIds()
  sink = null
  hostErrors = []
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
  it('retries a failed close settlement on cold read without a new provider child', async () => {
    await attach()
    emitTurnLifecycle('running', 1)
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      {
        kind: 'question',
        question: 'Before close?',
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    )
    await host.flushStreamedEvents(SESSION)
    const appendSettlement = vi.spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch')
    appendSettlement.mockRejectedValueOnce(new Error('close journal unavailable'))

    await host.close(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      settlementRetryRequired: true,
      settlementRetryFence: 1
    })
    appendSettlement.mockRestore()

    await reboot()
    await host.restoreReadableSessions()
    expect(acquire).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(store.getRecord(SESSION)?.lease.settlementRetryRequired).toBeUndefined()
    )
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok).toBe(true)
    if (history.ok) {
      expect(
        liveStructuredAgentSessionItems(history.page.items, 2).filter(
          (item) =>
            (item.body.kind === 'approval' || item.body.kind === 'question') &&
            item.body.resolution.state === 'pending'
        )
      ).toEqual([])
      expect(activeStructuredAgentSessionTurnId(history.page.items)).toBeNull()
    }
  })

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

  // The pane outlives the close by a few frames — a workspace delete closes the chats inside it
  // while their panes are still mounted — so whatever a read raises in that window is what the user
  // sees. This is the code the client narrows on to keep that window off the pane; a host that
  // starts raising a different one there puts the red error back.
  it('answers a read from the pane that outlived it with the code the client treats as transitional', async () => {
    await attach()
    await host.hold(SESSION, SURFACE)

    await host.close(SESSION)

    expect(host.hasSession(SESSION)).toBe(false)
    expect(() => host.history({ sessionId: SESSION, direction: 'tail' })).toThrow(
      AGENT_SESSION_UNATTACHED_REFUSAL_CODE
    )
    expect(() =>
      host.subscribe({ id: 'sub-1', sessionId: SESSION, emit: () => undefined })
    ).toThrow(AGENT_SESSION_UNATTACHED_REFUSAL_CODE)
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

  it('releases a compatibility wait when the session is evicted', async () => {
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
    const settlement = host.waitForSendSettlement(SESSION, result.value.clientMessageId)

    await host.close(SESSION)

    await expect(settlement).resolves.toBeUndefined()
  })

  it('retries teardown after journal close loses its result', async () => {
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

    await expect(host.close(SESSION)).rejects.toMatchObject({
      step: 'forget-session',
      cause: expect.objectContaining({ message: 'journal close result lost' })
    })
    expect(host.hasSession(SESSION)).toBe(true)
    expect(host['sessions'].get(SESSION)?.hasProviderChild).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(statusSink.forget).toHaveBeenCalledWith(SESSION)

    await expect(host.close(SESSION)).resolves.toBeUndefined()
    expect(host.hasSession(SESSION)).toBe(false)
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
    expect(session!.hasProviderChild).toBe(false)
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
  it('settles an idle absent owner without chat pollution and resumes the same provider identity', async () => {
    await attach()
    const beforeRestart = store.getRecord(SESSION)
    host['runtimeState'].stopLeaseRenewal()
    host['holds'].dispose()
    await host['sessions'].get(SESSION)?.journal.close()
    host['sessions'].clear()

    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    openHost(async () => ({ outcome: 'pid-absent' }))
    await host.restoreReadableSessions()

    const restored = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(restored.ok && restored.page.items.some((item) => item.body.kind === 'status')).toBe(
      false
    )
    await vi.waitFor(() =>
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        ownerProcess: null,
        settlementRetryRequired: undefined
      })
    )

    await host.hold(SESSION, SURFACE)
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
    ).toBe(false)

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

    const recoveredHistory = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      recoveredHistory.ok &&
        hasUnansweredStructuredAgentSessionDispatch(recoveredHistory.page.submissions)
    ).toBe(false)
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
    // A send whose delivery outcome is unknown IS work in progress, so the reassuring outcome is
    // written — carrying the cause, and never the old bare `Provider exited: <reason>` row.
    const statuses = history.ok
      ? history.page.items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
      : []
    expect(statuses).toEqual([unexpectedProviderExitOutcome('provider exited')])
    expect(statuses.some((text) => text.startsWith('Provider exited'))).toBe(false)
    expect(
      history.ok &&
        history.page.items.find(
          (item) => item.body.kind === 'status' && item.body.text === statuses[0]
        )?.recovered
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
})

describe('a chat handed to a terminal and taken back', () => {
  // The wind-down a close owes belongs to the child in front of it, not to whatever the LAST
  // eviction found. A session a terminal owns is indexed with no child of its own, so a close
  // there records "nothing owed" — and the trip back re-acquires into that SAME session object.
  it('settles and releases the child it was given back', async () => {
    const transcriptPath = await writeTuiTranscript()
    await host.flushAllStreamedEvents()
    openHandoffHost(transcriptPath)
    await attach()
    expect(await host.requestHandoff(CALLER, handoffRequest('to-tui'))).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui' })
    )

    // The app restarts and cannot reach the terminal, so this generation restores the session for
    // reading and holds no handle to the owner it would otherwise stop on a close.
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    tuiRecoverable = false
    openHandoffHost(transcriptPath)
    await host.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'tui',
      claimStatus: 'live'
    })

    failNextDrain()
    await expect(host.close(SESSION)).rejects.toMatchObject({ step: 'drain-published' })
    expect(host.hasSession(SESSION)).toBe(true)

    // The terminal answers again, and the status read the reopened pane makes recovers the owner.
    tuiRecoverable = true
    expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui' })
    expect(await host.requestHandoff(CALLER, handoffRequest('to-native'))).toMatchObject({
      ok: true
    })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
    )
    expect(host['sessions'].get(SESSION)?.hasProviderChild).toBe(true)
    await sendPending('pending when the retaken chat closes')
    const settled = captureSettledSubmissions()

    await expect(host.close(SESSION)).resolves.toBeUndefined()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(hasUnansweredStructuredAgentSessionDispatch(settled.value)).toBe(false)
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
    expect(host['sessions'].get(SESSION)?.hasProviderChild).toBe(false)
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
