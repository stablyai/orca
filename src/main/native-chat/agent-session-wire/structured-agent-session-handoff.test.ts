import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  reserveStoredAgentSessionHandoffOwner,
  setStoredAgentSessionHandoffStage,
  stopStoredAgentSessionOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import { createStructuredAgentSessionHandoffTestCoordinator } from './structured-agent-session-handoff-test-coordinator'
import {
  STRUCTURED_HANDOFF_PROVIDER_CASES,
  structuredHandoffTestLink,
  structuredHandoffTestProcess,
  type StructuredHandoffProviderCase
} from './structured-agent-session-handoff-test-identities'
import {
  StructuredHandoffTestRequests,
  type StructuredHandoffTestRequestOptions
} from './structured-agent-session-handoff-test-requests'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const NOW = 1_800_000_000_000
const SESSION = 'session-handoff'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const CLAUDE_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

let providerCase: StructuredHandoffProviderCase

let root: string
let store: AgentSessionRecordStore
let journal: Awaited<ReturnType<typeof openAgentSessionJournal>>
let coordinator: StructuredAgentSessionHandoffCoordinator
let statuses: AgentSessionHandoffStatus[]
let tuiIdle: boolean
let tuiReadiness: 'idle' | 'exited' | null
let importFailure: Error | null
let nativeAcquireFailure: Error | null
let launchTui: ReturnType<typeof vi.fn<StructuredAgentSessionHandoffTransport['launchTui']>>
let closeTuiOwner: ReturnType<
  typeof vi.fn<NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>>
>
let waitForTuiIdleOrExit: ReturnType<
  typeof vi.fn<StructuredAgentSessionHandoffTransport['waitForTuiIdleOrExit']>
>
let reproveTuiOwner: ReturnType<
  typeof vi.fn<StructuredAgentSessionHandoffTransport['reproveTuiOwner']>
>
let stopFailedTuiLaunch: ReturnType<
  typeof vi.fn<NonNullable<StructuredAgentSessionHandoffTransport['stopFailedTuiLaunch']>>
>
let acquireNativeStop: ReturnType<typeof vi.fn<(turnId: string) => Promise<boolean>>>
let acquireNativeCalls: number
let stopRecoveredOwner: ReturnType<
  typeof vi.fn<StructuredAgentSessionHandoffTransport['stopRecoveredOwner']>
>
const requests = new StructuredHandoffTestRequests(
  NOW,
  SESSION,
  () => store.getRecord(SESSION)?.lease.runtimeFence ?? 1
)

const operationId = (): string => requests.operationId()

function request(
  direction: Parameters<StructuredHandoffTestRequests['request']>[0],
  mode: Parameters<StructuredHandoffTestRequests['request']>[1],
  options: StructuredHandoffTestRequestOptions = {}
): AgentSessionHandoffRequest {
  return requests.request(direction, mode, options)
}

function submit(params: AgentSessionHandoffRequest) {
  return coordinator.request('client-1', params)
}

async function expectAccepted(params: AgentSessionHandoffRequest): Promise<void> {
  expect(await submit(params)).toMatchObject({ ok: true })
}

function process(spawnToken: string, pid: number) {
  return structuredHandoffTestProcess(NOW, spawnToken, pid)
}

function link(fence: number, id: string) {
  return structuredHandoffTestLink({
    provider: providerCase.provider,
    fence,
    id,
    now: NOW,
    claudeSessionId: CLAUDE_SESSION,
    codexThreadId: THREAD
  })
}

async function establishNativeOwner(): Promise<void> {
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: providerCase.provider,
    accountHome: {
      variable: providerCase.accountHome.variable,
      path: join(root, providerCase.accountHome.pathName)
    },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'native-initial',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: 'initial' },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: process('native-initial', 4100),
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: { ...link(fence, 'initial-link'), origin: 'created' },
    now: NOW
  })
}

function makeTuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: {
      handle: 'term-tui',
      tabId: 'tab-tui',
      paneKey: 'tab-tui:leaf-tui',
      ptyId: 'pty-tui'
    },
    process: process(spawnToken, 4200),
    link: link(fence, `tui-link-${fence}`),
    transcriptPath: join(root, 'rollout.jsonl')
  }
}

async function acquireNative(input: {
  sessionId: string
  fence: number
  spawnToken: string
}): Promise<AgentSessionRecord> {
  acquireNativeCalls += 1
  if (providerCase.provider === 'claude') {
    const chain = store.getRecord(input.sessionId)?.providerHandleChain ?? []
    if (
      chain.some(
        (entry) => entry.handle.provider === 'claude' && entry.handle.leafUuid === 'tui-exit-leaf'
      )
    ) {
      expect(chain.at(-1)?.handle).toEqual({
        provider: 'claude',
        sessionId: CLAUDE_SESSION,
        leafUuid: 'tui-exit-leaf'
      })
    }
  }
  if (nativeAcquireFailure) {
    const error = nativeAcquireFailure
    nativeAcquireFailure = null
    throw error
  }
  await store.commitProcessIdentity({
    sessionId: input.sessionId,
    fence: input.fence,
    process: process(input.spawnToken, 4300 + acquireNativeCalls),
    now: NOW
  })
  return store.proveOwner({
    sessionId: input.sessionId,
    fence: input.fence,
    link: link(input.fence, `native-link-${input.fence}`),
    now: NOW
  })
}

function createCoordinator(): StructuredAgentSessionHandoffCoordinator {
  return createStructuredAgentSessionHandoffTestCoordinator({
    store,
    journal,
    sessionId: SESSION,
    provider: providerCase.provider,
    claudeSessionId: CLAUDE_SESSION,
    codexThreadId: THREAD,
    now: NOW,
    launchTui,
    reproveTuiOwner,
    recoverTuiOwner: async (record) => {
      const owner = makeTuiOwner(
        record.lease.runtimeFence,
        record.lease.ownerProcess?.spawnToken ?? record.lease.reservedSpawnToken ?? 'recovered'
      )
      return { ...owner, process: record.lease.ownerProcess ?? owner.process }
    },
    stopRecoveredOwner,
    closeTuiOwner,
    waitForTuiExit: vi.fn(),
    waitForTuiIdleOrExit,
    tuiStatus: () => (tuiIdle ? 'idle' : 'busy'),
    stopFailedTuiLaunch,
    acquireNative,
    acquireNativeStop: (turnId) => acquireNativeStop(turnId),
    takeImportFailure: () => {
      if (importFailure) {
        const error = importFailure
        importFailure = null
        return error
      }
      return null
    },
    statuses
  })
}

async function appendStatus(state: 'running' | 'completed'): Promise<void> {
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn-status' },
    { kind: 'status', text: state, turnLifecycle: { turnId: 'turn-1', state } },
    { fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }
  )
}

async function waitForPhase(phase: AgentSessionHandoffStatus['phase']): Promise<void> {
  await vi.waitFor(() => expect(coordinator.status(SESSION).phase).toBe(phase))
}

async function moveToTui(): Promise<void> {
  expect(await submit(request('to-tui', 'now'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(coordinator.status(SESSION)).toMatchObject({ owner: 'tui' }))
}

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), `orca-${providerCase.provider}-handoff-`))
  requests.reset()
  statuses = []
  tuiIdle = true
  tuiReadiness = 'idle'
  importFailure = null
  nativeAcquireFailure = null
  acquireNativeCalls = 0
  stopRecoveredOwner = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  await establishNativeOwner()
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: providerCase.provider,
      providerHandle:
        providerCase.provider === 'claude'
          ? { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'current-leaf' }
          : { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
  launchTui = vi.fn(async ({ fence, spawnToken }) => makeTuiOwner(fence, spawnToken))
  closeTuiOwner = vi.fn(async (owner, persistHandle) => {
    if (owner.link.handle.provider === 'claude' && persistHandle) {
      await persistHandle({
        ...owner.link,
        linkId: `tui-exit-${owner.link.mintedAtFence}`,
        handle: { ...owner.link.handle, leafUuid: 'tui-exit-leaf' }
      })
    }
    return { transcriptPath: owner.transcriptPath }
  })
  waitForTuiIdleOrExit = vi.fn(async () => tuiReadiness)
  reproveTuiOwner = vi.fn(async ({ record, owner }) => {
    expect(record.lease.ownerProcess).toEqual(owner.process)
    if (record.lease.provenHandleLinkId !== null) {
      expect(record.lease.provenHandleLinkId).toBe(owner.link.linkId)
    }
    return owner
  })
  stopFailedTuiLaunch = vi.fn(async () => undefined)
  acquireNativeStop = vi.fn(async () => true)
  coordinator = createCoordinator()
}

async function teardown(): Promise<void> {
  await coordinator.drain()
  await rm(root, { recursive: true, force: true })
}

describe.each(STRUCTURED_HANDOFF_PROVIDER_CASES)(
  '$provider structured session ownership handoff',
  (currentProvider) => {
    beforeEach(async () => {
      providerCase = currentProvider
      await setup()
    })

    afterEach(teardown)

    it('completes native to TUI to native with one owner and journal continuity', async () => {
      await journal.appendItem(
        providerCase.provider === 'claude'
          ? { provider: 'claude', sessionId: CLAUDE_SESSION, uuid: 'native-turn' }
          : { provider: 'codex', threadId: THREAD, turnId: 'native-turn', ordinal: 0 },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'from native' }] },
        { fence: 1 }
      )
      await moveToTui()
      const forwardRecord = store.getRecord(SESSION)!
      expect(forwardRecord.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null
      })

      expect(await submit(request('to-native', 'after-turn'))).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(coordinator.status(SESSION)).toMatchObject({ owner: 'native' }))

      expect(reproveTuiOwner).toHaveBeenCalledWith({
        record: expect.objectContaining({
          lease: expect.objectContaining({
            ownerProcess: forwardRecord.lease.ownerProcess,
            provenHandleLinkId: forwardRecord.lease.provenHandleLinkId
          })
        }),
        owner: expect.objectContaining({
          process: forwardRecord.lease.ownerProcess,
          link: expect.objectContaining({ linkId: forwardRecord.lease.provenHandleLinkId })
        })
      })
      expect(closeTuiOwner).toHaveBeenCalledOnce()

      const messages = journal.snapshot().items.filter((item) => item.body.kind === 'message')
      expect(messages).toHaveLength(2)
      expect(new Set(messages.map((item) => item.itemId)).size).toBe(2)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'native',
        handoffStage: null
      })
    })

    it('queues a busy native turn, supports cancel, and starts only after idle', async () => {
      await appendStatus('running')
      expect(await submit(request('to-tui', 'after-turn'))).toMatchObject({ ok: true })
      expect(coordinator.status(SESSION).phase).toBe('queued')
      await expectAccepted(request('to-tui', 'after-turn', { action: 'cancel-queued' }))
      await appendStatus('completed')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(launchTui).not.toHaveBeenCalled()

      await appendStatus('running')
      expect(await submit(request('to-tui', 'after-turn'))).toMatchObject({ ok: true })
      await appendStatus('completed')
      await vi.waitFor(() => expect(launchTui).toHaveBeenCalledOnce())
    })

    it('durably replays a completed queued cancellation after restart', async () => {
      await appendStatus('running')
      const queued = request('to-tui', 'after-turn')
      expect(await submit(queued)).toMatchObject({ ok: true })
      const cancellation = request('to-tui', 'after-turn', { action: 'cancel-queued' })
      expect(await submit(cancellation)).toMatchObject({ ok: true, replayed: false })

      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      coordinator = createCoordinator()

      expect(await submit(cancellation)).toMatchObject({ ok: true, replayed: true })
      expect((await submit(queued)).ok).toBe(false)
    })

    it('replays a duplicate active handoff without launching a second owner', async () => {
      let finishLaunch!: () => void
      launchTui.mockImplementationOnce(
        ({ fence, spawnToken }) =>
          new Promise((resolve) => {
            finishLaunch = () => resolve(makeTuiOwner(fence, spawnToken))
          })
      )
      const operation = operationId()
      const first = request('to-tui', 'now', { operationId: operation })
      expect(await submit(first)).toMatchObject({ ok: true, replayed: false })
      await vi.waitFor(() => expect(launchTui).toHaveBeenCalledOnce())
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving'
      })
      expect(coordinator.status(SESSION).owner).not.toBe('tui')
      expect(await submit(first)).toMatchObject({ ok: true, replayed: true })
      finishLaunch()
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('tui'))
      expect(launchTui).toHaveBeenCalledOnce()
    })

    it('replays the same completed handoff operation after the coordinator restarts', async () => {
      const operation = operationId()
      const first = request('to-tui', 'now', { operationId: operation })
      expect(await submit(first)).toMatchObject({ ok: true, replayed: false })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('tui'))
      await coordinator.drain()

      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      coordinator = createCoordinator()
      expect(await submit(first)).toMatchObject({ ok: true, replayed: true })
      expect(launchTui).toHaveBeenCalledOnce()
    })

    it('continues a persisted preparing stage after restart instead of stranding it', async () => {
      const operation = operationId()
      const first = request('to-tui', 'now', { operationId: operation })
      await store.admitOperation({
        callerKey: 'client-1',
        operationId: operation,
        fingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.requestHandoff.operation',
          sessionId: SESSION,
          fields: { direction: 'to-tui' }
        }),
        now: NOW
      })
      await setStoredAgentSessionHandoffStage(store, {
        sessionId: SESSION,
        fence: 1,
        stage: 'preparing',
        handoffOperationId: operation,
        now: NOW
      })
      coordinator = createCoordinator()

      await coordinator.restore(SESSION)

      expect(stopRecoveredOwner).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null
      })
      await coordinator.drain()
      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      coordinator = createCoordinator()
      expect(await submit(first)).toMatchObject({ ok: true, replayed: true })
      expect(launchTui).toHaveBeenCalledOnce()
    })

    it('finishes a live new-owner-proving stage after restart', async () => {
      const operation = operationId()
      let record = await setStoredAgentSessionHandoffStage(store, {
        sessionId: SESSION,
        fence: 1,
        stage: 'preparing',
        handoffOperationId: operation,
        now: NOW
      })
      record = await stopStoredAgentSessionOwnerForHandoff(store, {
        sessionId: SESSION,
        expectedFence: record.lease.runtimeFence,
        operationId: operation,
        now: NOW
      })
      const spawnToken = 'restarted-tui'
      record = await reserveStoredAgentSessionHandoffOwner(store, {
        sessionId: SESSION,
        expectedFence: record.lease.runtimeFence,
        runtimeKind: 'tui',
        spawnToken,
        operationId: operation,
        claimKeyId: 'key-1',
        now: NOW
      })
      await store.commitProcessIdentity({
        sessionId: SESSION,
        fence: record.lease.runtimeFence,
        process: process(spawnToken, 4400),
        now: NOW
      })
      coordinator = createCoordinator()

      await coordinator.restore(SESSION)

      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null
      })
      expect(coordinator.status(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })
    })

    it('clears stale recovery after re-proving the live TUI owner', async () => {
      await moveToTui()
      const record = store.getRecord(SESSION)!
      await setStoredAgentSessionHandoffStage(store, {
        sessionId: SESSION,
        fence: record.lease.runtimeFence,
        stage: 'manual-recovery',
        handoffOperationId: null,
        now: NOW
      })
      coordinator = createCoordinator()

      await coordinator.restore(SESSION)
      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        phase: 'idle',
        stage: null,
        terminal: { handle: 'term-tui' }
      })
      expect(reproveTuiOwner).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null,
        handoffOperationId: null
      })
    })

    it('recovers native ownership when a stressed TUI recovery process is gone', async () => {
      await moveToTui()
      const record = store.getRecord(SESSION)!
      await setStoredAgentSessionHandoffStage(store, {
        sessionId: SESSION,
        fence: record.lease.runtimeFence,
        stage: 'manual-recovery',
        handoffOperationId: null,
        now: NOW
      })
      reproveTuiOwner.mockRejectedValueOnce(new Error('The owning terminal was killed.'))
      coordinator = createCoordinator()

      await coordinator.restore(SESSION)

      expect(stopRecoveredOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION,
          lease: expect.objectContaining({ runtimeKind: 'tui' })
        })
      )
      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'native',
        phase: 'idle',
        stage: null
      })
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'native',
        claimStatus: 'live',
        handoffStage: null,
        handoffOperationId: null
      })
    })

    it('rejects cancellation once a queued handoff is no longer pending', async () => {
      expect(
        await submit(request('to-tui', 'after-turn', { action: 'cancel-queued' }))
      ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_conflict' } })
      expect(coordinator.status(SESSION)).toMatchObject({ owner: 'native', phase: 'idle' })
    })

    it('durably replays a queued-cancellation refusal as a refusal', async () => {
      const cancellation = request('to-tui', 'after-turn', { action: 'cancel-queued' })
      expect(await submit(cancellation)).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_operation_conflict' }
      })

      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      coordinator = createCoordinator()

      expect(await submit(cancellation)).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_operation_conflict' }
      })
      expect(launchTui).not.toHaveBeenCalled()
    })

    it('requires acknowledged cancellation before stopping a native turn', async () => {
      await appendStatus('running')
      expect(await submit(request('to-tui', 'stop-turn'))).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('tui'))
      expect(acquireNativeStop).toHaveBeenCalledWith('turn-1')
      expect(acquireNativeStop.mock.invocationCallOrder[0]).toBeLessThan(
        launchTui.mock.invocationCallOrder[0] ?? Infinity
      )
    })

    it('fires a queued TUI transfer from the turn-completion waiter', async () => {
      await moveToTui()
      tuiIdle = false
      tuiReadiness = null
      expect(await submit(request('to-native', 'after-turn'))).toMatchObject({ ok: true })
      expect(coordinator.status(SESSION).phase).toBe('queued')
      expect(closeTuiOwner).not.toHaveBeenCalled()
      tuiIdle = true
      tuiReadiness = 'idle'
      await vi.waitFor(() => expect(closeTuiOwner).toHaveBeenCalledOnce())
    })

    it('closes the owning TUI and completes a mobile-originated queued reverse', async () => {
      await moveToTui()
      tuiIdle = false
      tuiReadiness = null
      const reverse = request('to-native', 'after-turn')

      expect(await coordinator.request('mobile-device-a', reverse)).toMatchObject({ ok: true })
      expect(coordinator.status(SESSION).phase).toBe('queued')
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))

      expect(reproveTuiOwner).toHaveBeenCalledOnce()
      expect(closeTuiOwner).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'native',
        claimStatus: 'live',
        handoffStage: null
      })
    })

    it('re-proves the current TUI handle before accepting its exit and importing history', async () => {
      await moveToTui()
      const reverse = request('to-native', 'now')
      expect(await submit(reverse)).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))

      expect(reproveTuiOwner).toHaveBeenCalledOnce()
      expect(reproveTuiOwner.mock.invocationCallOrder[0]).toBeLessThan(
        closeTuiOwner.mock.invocationCallOrder[0] ?? Infinity
      )
    })

    it('does not close or import when the current TUI handle cannot be re-proved', async () => {
      await moveToTui()
      reproveTuiOwner.mockRejectedValueOnce(new Error('provider handle changed'))
      expect(await submit(request('to-native', 'now'))).toMatchObject({ ok: true })
      await waitForPhase('failed')

      expect(closeTuiOwner).not.toHaveBeenCalled()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null
      })
    })

    it('rolls a stale reverse handle back to one durable TUI owner and retries', async () => {
      await moveToTui()
      closeTuiOwner.mockRejectedValueOnce(new Error('terminal_handle_stale'))
      const retryOperation = operationId()

      await expectAccepted(request('to-native', 'now', { operationId: retryOperation }))
      await waitForPhase('failed')

      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        operationId: retryOperation,
        error: { recoverableOwner: 'tui', details: 'terminal_handle_stale' }
      })
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null,
        handoffOperationId: null
      })

      await expectAccepted(
        request('to-native', 'now', { action: 'retry', operationId: retryOperation })
      )
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))
      expect(closeTuiOwner).toHaveBeenCalledTimes(2)
    })

    it('keeps one recoverable owner when a queued reverse auto-fire fails', async () => {
      await moveToTui()
      tuiIdle = false
      tuiReadiness = null
      closeTuiOwner.mockRejectedValueOnce(new Error('terminal_handle_stale'))

      expect(await submit(request('to-native', 'after-turn'))).toMatchObject({ ok: true })
      expect(coordinator.status(SESSION).phase).toBe('queued')
      tuiIdle = true
      tuiReadiness = 'idle'
      await waitForPhase('failed')

      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        error: { recoverableOwner: 'tui', details: 'terminal_handle_stale' }
      })
    })

    it('recovers native ownership and refuses retry over a new native turn', async () => {
      launchTui.mockRejectedValueOnce(new Error('resume proof failed'))
      const retryOperation = operationId()
      expect(await submit(request('to-tui', 'now', { operationId: retryOperation }))).toMatchObject(
        { ok: true }
      )
      await waitForPhase('failed')
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'native',
        claimStatus: 'live',
        handoffStage: null
      })
      await appendStatus('running')
      const retry = await submit(
        request('to-tui', 'now', { action: 'retry', operationId: retryOperation })
      )
      expect(retry).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_conflict' }
      })
    })

    it('stops a launched but uncommitted TUI before recovering native', async () => {
      launchTui.mockImplementationOnce(async ({ fence, spawnToken }) => ({
        ...makeTuiOwner(fence, spawnToken),
        link: link(fence + 1, 'bad-proof')
      }))
      expect(await submit(request('to-tui', 'now'))).toMatchObject({ ok: true })
      await waitForPhase('failed')
      expect(stopFailedTuiLaunch).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease.runtimeKind).toBe('native')
    })

    it('completes a queued second cycle and keeps native recoverable after a dead relaunch', async () => {
      await moveToTui()
      expect(await submit(request('to-native', 'after-turn'))).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))
      await appendStatus('running')
      expect(await submit(request('to-tui', 'after-turn'))).toMatchObject({ ok: true })
      await appendStatus('completed')
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('tui'))
      expect(await submit(request('to-native', 'after-turn'))).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))

      launchTui.mockImplementationOnce(async ({ fence, spawnToken }) => ({
        ...makeTuiOwner(fence, spawnToken),
        link: link(fence + 1, 'dead-relaunch')
      }))

      expect(await submit(request('to-tui', 'now'))).toMatchObject({ ok: true })
      await waitForPhase('failed')

      expect(stopFailedTuiLaunch).toHaveBeenCalledOnce()
      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'native',
        error: { recoverableOwner: 'native' }
      })
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'native',
        claimStatus: 'live',
        handoffStage: null,
        handoffOperationId: null
      })
    })

    it('requires manual recovery when a failed TUI launch cannot be proven stopped', async () => {
      launchTui.mockImplementationOnce(async ({ fence, spawnToken }) => ({
        ...makeTuiOwner(fence, spawnToken),
        link: link(fence + 1, 'bad-proof')
      }))
      stopFailedTuiLaunch.mockRejectedValueOnce(new Error('exit unproved'))
      const failedOperation = operationId()
      expect(
        await submit(request('to-tui', 'now', { operationId: failedOperation }))
      ).toMatchObject({
        ok: true
      })
      await waitForPhase('failed')

      expect(coordinator.status(SESSION)).toMatchObject({
        stage: 'manual-recovery',
        error: { recoverableOwner: 'none', canRetryProof: true }
      })
      expect(await submit(request('to-tui', 'now', { action: 'recover' }))).toMatchObject({
        ok: true
      })
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('tui'))
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'live',
        handoffStage: null,
        handoffOperationId: null
      })
      expect(acquireNativeCalls).toBe(0)
    })

    it('retains the stopped TUI session for retry when native resume fails', async () => {
      await moveToTui()
      importFailure = new Error('history unavailable')
      const retryOperation = operationId()
      await expectAccepted(request('to-native', 'after-turn', { operationId: retryOperation }))
      await waitForPhase('failed')
      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        operationId: retryOperation,
        error: { recoverableOwner: 'tui' }
      })
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'released',
        handoffStage: 'old-owner-stopped'
      })

      await expectAccepted(
        request('to-native', 'now', { action: 'retry', operationId: retryOperation })
      )
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))
      expect(closeTuiOwner).toHaveBeenCalledOnce()
    })

    it('abandons a failed native acquisition and retries from the stopped TUI', async () => {
      await moveToTui()
      nativeAcquireFailure = new Error('native proof unavailable')
      const retryOperation = operationId()
      await expectAccepted(request('to-native', 'after-turn', { operationId: retryOperation }))
      await waitForPhase('failed')

      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        operationId: retryOperation,
        error: { recoverableOwner: 'tui' }
      })
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        runtimeKind: 'tui',
        claimStatus: 'released',
        handoffStage: 'old-owner-stopped'
      })

      coordinator = createCoordinator()
      expect(coordinator.status(SESSION)).toMatchObject({
        owner: 'tui',
        direction: 'to-native',
        phase: 'failed',
        operationId: retryOperation
      })
      await expectAccepted(
        request('to-native', 'now', { action: 'retry', operationId: retryOperation })
      )
      await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))
      expect(closeTuiOwner).toHaveBeenCalledOnce()
      expect(acquireNativeCalls).toBe(2)
    })

    it('publishes every durable stage so concurrent clients see the same transfer', async () => {
      await moveToTui()
      expect(statuses.map((status) => status.stage)).toEqual(
        expect.arrayContaining(['preparing', 'old-owner-stopped', 'new-owner-proving', null])
      )
      expect(statuses.filter((status) => status.phase === 'switching')).toHaveLength(3)
    })
  }
)
