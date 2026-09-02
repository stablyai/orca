import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import { createStructuredHandoffFlowContext } from './structured-agent-session-handoff-flow-context'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const NOW = 1_800_000_000_000
const SESSION = 'session-handoff'
const PLAIN_RESIDUE = 'session-plain-residue'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

let root: string
let store: AgentSessionRecordStore
let journal: Awaited<ReturnType<typeof openAgentSessionJournal>>
let coordinator: StructuredAgentSessionHandoffCoordinator
let statuses: AgentSessionHandoffStatus[]
type TransportMock<K extends keyof StructuredAgentSessionHandoffTransport> = ReturnType<
  typeof vi.fn<
    Extract<NonNullable<StructuredAgentSessionHandoffTransport[K]>, (...args: never[]) => unknown>
  >
>
let launchTui: TransportMock<'launchTui'>
let waitForTuiExit: TransportMock<'waitForTuiExit'>
let closeTuiOwner: TransportMock<'closeTuiOwner'>
let waitForTuiIdleOrExit: TransportMock<'waitForTuiIdleOrExit'>
let reproveTuiOwner: TransportMock<'reproveTuiOwner'>
let stopFailedTuiLaunch: TransportMock<'stopFailedTuiLaunch'>
let acquireNativeStop: ReturnType<typeof vi.fn<(turnId: string) => Promise<boolean>>>
let acquireNativeCalls: number
let stopRecoveredOwner: TransportMock<'stopRecoveredOwner'>
let operations: number
type HistoryCatchup = (sessionId: string, fence: number) => Promise<void>
let prepareTuiHistoryCatchup: ReturnType<typeof vi.fn<HistoryCatchup>>
let recoverTuiHistoryCatchup: ReturnType<typeof vi.fn<HistoryCatchup>>
let activateTuiHistoryCatchup: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>
let stopTuiHistoryCatchup: ReturnType<typeof vi.fn<(sessionId: string) => void>>

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function process(spawnToken: string, pid: number) {
  return {
    hostId: 'local',
    pid,
    processStartTimeMs: NOW - 1_000,
    spawnToken
  }
}

function link(fence: number, id: string) {
  return {
    linkId: id,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: 'resumed' as const,
    mintedAtFence: fence,
    observedAt: NOW
  }
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
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
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

function createCoordinator(): StructuredAgentSessionHandoffCoordinator {
  return new StructuredAgentSessionHandoffCoordinator({
    store,
    claimKeyId: 'key-1',
    transport: {
      hostLabel: 'Test host',
      launchTui,
      reproveTuiOwner,
      recoverTuiOwner: async (record) => {
        const owner = makeTuiOwner(
          record.lease.runtimeFence,
          record.lease.ownerProcess?.spawnToken ?? record.lease.reservedSpawnToken ?? 'recovered'
        )
        return { ...owner, process: record.lease.ownerProcess ?? owner.process }
      },
      probeRecoveredOwner: async () => 'dead',
      stopRecoveredOwner,
      closeTuiOwner,
      waitForTuiExit,
      waitForTuiIdleOrExit,
      tuiStatus: () => 'idle',
      stopFailedTuiLaunch
    },
    session: () => ({
      journal,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    }),
    suspendNative: vi.fn(async () => ({ state: 'stopped' as const })),
    acquireNative: async (input) => {
      acquireNativeCalls += 1
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
    },
    acquireNativeStop: (_sessionId, turnId) => acquireNativeStop(turnId),
    importTuiHistory: async ({ fence }) => {
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'tui-turn', ordinal: 0 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'from tui' }] },
        { fence, recovered: true }
      )
    },
    prepareTuiHistoryCatchup,
    recoverTuiHistoryCatchup,
    activateTuiHistoryCatchup,
    stopTuiHistoryCatchup,
    publish: (_sessionId, status) => statuses.push(status),
    schedule: async (_sessionId, task) => task(),
    now: () => NOW
  })
}

function request(operation: string): AgentSessionHandoffRequest {
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operation,
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: 'test-handoff'
    },
    direction: 'to-tui',
    mode: 'now'
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-'))
  operations = 0
  statuses = []
  acquireNativeCalls = 0
  prepareTuiHistoryCatchup = vi.fn(async () => undefined)
  recoverTuiHistoryCatchup = vi.fn(async () => undefined)
  activateTuiHistoryCatchup = vi.fn(async () => undefined)
  stopTuiHistoryCatchup = vi.fn()
  stopRecoveredOwner = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  await establishNativeOwner()
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
  launchTui = vi.fn(async ({ fence, spawnToken }) => makeTuiOwner(fence, spawnToken))
  waitForTuiExit = vi.fn(async (owner) => ({ transcriptPath: owner.transcriptPath }))
  closeTuiOwner = vi.fn(async (owner) => ({ transcriptPath: owner.transcriptPath }))
  waitForTuiIdleOrExit = vi.fn(async () => 'idle')
  reproveTuiOwner = vi.fn(async ({ owner }) => owner)
  stopFailedTuiLaunch = vi.fn(async () => undefined)
  acquireNativeStop = vi.fn(async () => true)
  coordinator = createCoordinator()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('structured session handoff failure handling', () => {
  it('parks a stopped native cleanup failure in manual recovery without launching TUI', async () => {
    const operation = operationId()
    const cleanupError = new Error('journal drain failed')
    const retainOwner = vi.fn()
    const releaseOwner = vi.fn()
    const context = createStructuredHandoffFlowContext({
      deps: {
        store,
        claimKeyId: 'key-1',
        transport: {
          hostLabel: 'Test host',
          launchTui,
          reproveTuiOwner,
          recoverTuiOwner: async (record) => makeTuiOwner(record.lease.runtimeFence, 'recovered'),
          stopRecoveredOwner,
          closeTuiOwner,
          waitForTuiExit,
          waitForTuiIdleOrExit,
          tuiStatus: () => 'idle',
          stopFailedTuiLaunch
        },
        session: () => ({
          journal,
          fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1
        }),
        suspendNative: vi.fn(async () => ({
          state: 'stopped-cleanup-failed' as const,
          error: cleanupError
        })),
        acquireNative: vi.fn(async () => {
          throw new Error('native acquisition should not run')
        }),
        acquireNativeStop: (_sessionId, turnId) => acquireNativeStop(turnId),
        importTuiHistory: vi.fn(async () => undefined),
        prepareTuiHistoryCatchup,
        recoverTuiHistoryCatchup,
        activateTuiHistoryCatchup,
        stopTuiHistoryCatchup,
        publish: (_sessionId, status) => statuses.push(status),
        schedule: async (_sessionId, task) => task(),
        now: () => NOW
      },
      owner: () => undefined,
      retainOwner,
      releaseOwner,
      setStatus: (_sessionId, status) => statuses.push(status),
      requireRecord: (sessionId) => {
        const record = store.getRecord(sessionId)
        if (!record) {
          throw new Error('missing record')
        }
        return record
      }
    })

    await expect(handoffStructuredSessionToTui(context, request(operation), false)).rejects.toBe(
      cleanupError
    )

    expect(launchTui).not.toHaveBeenCalled()
    expect(retainOwner).not.toHaveBeenCalled()
    expect(releaseOwner).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'released',
      handoffStage: 'manual-recovery',
      handoffOperationId: operation,
      ownerProcess: null
    })
  })
})

// The direction-agnostic restore path is the crash-during-acquisition recovery every
// plain direct launch depends on: restart adjudication parks a crashed acquire at a
// handoff stage, and restore() is what un-strands it. The interactive handoff request
// flow itself is deliberately absent from this build.
describe('structured session ownership recovery on restore', () => {
  it('continues a persisted preparing stage after restart instead of stranding it', async () => {
    const operation = operationId()
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
    expect(recoverTuiHistoryCatchup).toHaveBeenCalledWith(
      SESSION,
      store.getRecord(SESSION)?.lease.runtimeFence
    )
  })

  it('continues only the persisted TUI handoff after a store restart', async () => {
    const plainOperation = operationId()
    await store.reserveOwner({
      sessionId: PLAIN_RESIDUE,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'plain-residue-token',
      claimKeyId: 'key-1',
      handoffOperationId: plainOperation,
      probe: { outcome: 'reservation-unused' },
      operation: { callerKey: 'test', operationId: plainOperation, fingerprint: 'plain-attach' },
      now: NOW
    })
    const handoffOperation = operationId()
    let interrupted = await setStoredAgentSessionHandoffStage(store, {
      sessionId: SESSION,
      fence: 1,
      stage: 'preparing',
      handoffOperationId: handoffOperation,
      now: NOW
    })
    interrupted = await stopStoredAgentSessionOwnerForHandoff(store, {
      sessionId: SESSION,
      expectedFence: interrupted.lease.runtimeFence,
      operationId: handoffOperation,
      now: NOW
    })
    const interruptedFence = interrupted.lease.runtimeFence

    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    await store.reconcileOnRestart({
      probe: async (record) =>
        record.sessionId === PLAIN_RESIDUE
          ? { outcome: 'indeterminate', reason: 'plain reservation cannot be attributed' }
          : { outcome: 'pid-absent' },
      now: NOW + 1_000
    })
    journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD }
      },
      journalDir: join(root, 'journal')
    })
    launchTui = vi.fn(async ({ fence, spawnToken }) => makeTuiOwner(fence, spawnToken))
    coordinator = createCoordinator()

    await coordinator.restore(PLAIN_RESIDUE)
    expect(launchTui).not.toHaveBeenCalled()
    expect(acquireNativeCalls).toBe(0)
    expect(store.getRecord(PLAIN_RESIDUE)?.lease).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: 'manual-recovery',
      claimStatus: 'reserved',
      reservedSpawnToken: 'plain-residue-token'
    })
    expect(
      store.listOperationRows().find((row) => row.operationId === plainOperation)?.outcome
    ).toMatchObject({ status: 'failed', code: 'agent_session_ownership_unknown' })

    await coordinator.restore(SESSION)

    expect(launchTui).toHaveBeenCalledOnce()
    expect(acquireNativeCalls).toBe(1)
    expect(launchTui.mock.calls[0]?.[0]).toMatchObject({
      record: {
        sessionId: SESSION,
        lease: { handoffOperationId: handoffOperation }
      },
      fence: interruptedFence + 3
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'tui',
      runtimeFence: interruptedFence + 3,
      handoffStage: null,
      handoffOperationId: null,
      claimStatus: 'live'
    })
  })
})
