import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { PtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'
import type { PtyOwnershipTransferPrepareResult } from '../../shared/pty-ownership-transfer-wire'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const connectionId = 'target-1'
const repoId = 'remote-repo'
const worktreeId = `${repoId}::/srv/repo`
const terminalId = 'relay-pty-1'
const ptyId = toAppSshPtyId(connectionId, terminalId)
const leafId = '11111111-1111-4111-8111-111111111111'
const tabId = 'tab-1'
const incarnationId = 'incarnation-1'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-runtime-transfer-checkpoint-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('OrcaRuntimeService ownership-transfer model checkpoint', () => {
  it('does not construct a mutation coordinator while the release gate is closed', () => {
    const runtime = new OrcaRuntimeService()
    const coordinator = runtime.createPtyOwnershipTransferCoordinator({
      connectionId,
      identity: {
        bridgeId: 'bridge-closed',
        terminalId,
        incarnationId,
        ownerLease: 'lease-closed',
        sourceOwnerGeneration: 1,
        destinationRuntimeId: runtime.getRuntimeId()
      },
      surfaceBinding: {
        executionHostId: toSshExecutionHostId(connectionId),
        workspaceKey: worktreeWorkspaceKey(worktreeId),
        tabId,
        leafId,
        ptyId
      }
    })

    expect(coordinator).toBeNull()
  })

  it('persists the exact admitted headless model and tolerates an exact retry', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: repoId, path: '/srv/repo', connectionId }))
    const runtime = new OrcaRuntimeService(store, undefined, {
      publishPtyOwnershipTransferPostCommitOutput: vi.fn(),
      publishPtyOwnershipTransferPostCommitOutputAcknowledged: (identity, _binding, frame) => ({
        identity,
        throughSeq: frame.seq
      })
    })
    const identity = {
      bridgeId: 'bridge-1',
      terminalId,
      incarnationId,
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 1,
      destinationRuntimeId: runtime.getRuntimeId()
    } as const
    const surfaceBinding = {
      executionHostId: toSshExecutionHostId(connectionId),
      workspaceKey: worktreeWorkspaceKey(worktreeId),
      tabId,
      leafId,
      ptyId
    } as const
    const prepareResult: PtyOwnershipTransferPrepareResult = {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding }
    }
    const commitReceipt: PtyOwnershipTransferCommitReceipt = {
      receiptId: 'commit-1',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 1,
      committedAt: '2026-08-31T12:00:00.000Z'
    }
    const registry = runtime.getPtyOwnershipTransferDestinationRegistry()
    const prepared = registry!.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({ ...prepareResult, frames: [{ seq: 1, data: 'baseline\n' }] })
    prepared.adapter.commit(commitReceipt)
    prepared.adapter.publish()
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })

    const admission = runtime.acceptPtyDataBounded(ptyId, 'live output\n', Date.now())
    await admission.completion
    const ownershipTransfer: PtyOwnershipTransferOutputEnvelope = {
      ...identity,
      version: 1,
      frameSeq: 2,
      fragmentStartSu: 0,
      fragmentEndSu: 12,
      frameLengthSu: 12
    }
    const checkpoint = {
      ptyId,
      ptyIncarnation: incarnationId,
      modelSequenceEnd: admission.sequence,
      projectionSequenceEnd: admission.sequence,
      ownershipTransfer,
      data: 'live output\n'
    }

    await runtime.checkpointPtyOwnershipTransferModel(checkpoint)
    await runtime.checkpointPtyOwnershipTransferModel(checkpoint)

    const session = store.getWorkspaceSession(toSshExecutionHostId(connectionId))
    const ref = session.terminalLayoutsByTabId[tabId]?.scrollbackRefsByLeafId?.[leafId]
    expect(ref && store.readTerminalScrollbackSnapshot(ref)).toContain('live output')

    runtime.onPtyData(ptyId, 'newer output\n', Date.now())
    await expect(runtime.checkpointPtyOwnershipTransferModel(checkpoint)).rejects.toThrow(
      'pty_ownership_transfer_model_checkpoint_sequence_mismatch'
    )
  })

  it('acknowledges a post-commit frame only after its exact model checkpoint', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: repoId, path: '/srv/repo', connectionId }))
    const runtime = new OrcaRuntimeService(store)
    expect(runtime.installPtyOwnershipTransferDestinationOutputBridge()).toBe(true)
    const identity = {
      bridgeId: 'bridge-ack',
      terminalId,
      incarnationId,
      ownerLease: 'lease-ack',
      sourceOwnerGeneration: 1,
      destinationRuntimeId: runtime.getRuntimeId()
    } as const
    const surfaceBinding = {
      executionHostId: toSshExecutionHostId(connectionId),
      workspaceKey: worktreeWorkspaceKey(worktreeId),
      tabId,
      leafId,
      ptyId
    } as const
    const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
    const prepared = registry.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding }
    })
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1,
      frames: [{ seq: 1, data: 'baseline\n' }]
    })
    prepared.adapter.commit({
      receiptId: 'commit-ack',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 1,
      committedAt: '2026-08-31T12:00:00.000Z'
    })
    prepared.adapter.publish()
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })

    const admission = runtime.acceptPtyDataBounded(ptyId, 'live output\n', Date.now())
    await admission.completion
    const ownershipTransfer: PtyOwnershipTransferOutputEnvelope = {
      ...identity,
      version: 1,
      frameSeq: 2,
      fragmentStartSu: 0,
      fragmentEndSu: 12,
      frameLengthSu: 12
    }
    await runtime.checkpointPtyOwnershipTransferModel({
      ptyId,
      ptyIncarnation: incarnationId,
      modelSequenceEnd: admission.sequence,
      projectionSequenceEnd: admission.sequence,
      ownershipTransfer,
      data: 'live output\n'
    })

    registry.acceptPostCommitOutput(identity, { seq: 2, data: 'live output\n' })
    expect(registry.pendingPostCommitOutput(identity)?.acknowledgedEndSeq).toBe(2)
    // Retries are idempotent and must not require model reinjection.
    registry.acceptPostCommitOutput(identity, { seq: 2, data: 'live output\n' })
    expect(runtime.getPtyOutputSequence(ptyId)).toBe(admission.sequence)
  })

  it('reuses the durable checkpoint ledger after a destination runtime restart', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: repoId, path: '/srv/repo', connectionId }))
    const runtimeId = 'runtime-restarted'
    const runtime = new OrcaRuntimeService(store, undefined, { runtimeId })
    runtime.installPtyOwnershipTransferDestinationOutputBridge()
    const identity = {
      bridgeId: 'bridge-restart',
      terminalId,
      incarnationId,
      ownerLease: 'lease-restart',
      sourceOwnerGeneration: 1,
      destinationRuntimeId: runtimeId
    } as const
    const surfaceBinding = {
      executionHostId: toSshExecutionHostId(connectionId),
      workspaceKey: worktreeWorkspaceKey(worktreeId),
      tabId,
      leafId,
      ptyId
    } as const
    const prepareResult = {
      ...identity,
      version: 1 as const,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 1,
      replayStartSeq: 1,
      surfacePublication: { version: 1 as const, surfaceBinding }
    }
    const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 1,
      replayStartSeq: 1,
      frames: [{ seq: 1, data: 'baseline\n' }]
    })
    prepared.adapter.commit({
      receiptId: 'commit-restart',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 1,
      committedAt: '2026-08-31T12:00:00.000Z'
    })
    prepared.adapter.publish()
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    const admission = runtime.acceptPtyDataBounded(ptyId, 'restart output\n', Date.now())
    await admission.completion
    const ownershipTransfer: PtyOwnershipTransferOutputEnvelope = {
      ...identity,
      version: 1,
      frameSeq: 2,
      fragmentStartSu: 0,
      fragmentEndSu: 15,
      frameLengthSu: 15
    }
    await runtime.checkpointPtyOwnershipTransferModel({
      ptyId,
      ptyIncarnation: incarnationId,
      modelSequenceEnd: admission.sequence,
      projectionSequenceEnd: admission.sequence,
      ownershipTransfer,
      data: 'restart output\n'
    })
    registry.stagePostCommitOutput(identity, { seq: 2, data: 'restart output\n' })

    const restarted = new OrcaRuntimeService(store, undefined, { runtimeId })
    restarted.installPtyOwnershipTransferDestinationOutputBridge()
    restarted.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    const restartedRegistry = restarted.getPtyOwnershipTransferDestinationRegistry()!
    restartedRegistry.acceptPostCommitOutput(identity, { seq: 2, data: 'restart output\n' })
    expect(restartedRegistry.pendingPostCommitOutput(identity)?.acknowledgedEndSeq).toBe(2)
  })
})
