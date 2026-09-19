import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipTransferDestinationPublicationRequest } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferCommitReceipt } from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferWireIdentity
} from '../../../shared/pty-ownership-transfer-wire'
import { createStore, testState } from '../../persistence-test-harness'
import {
  PtyOwnershipTransferDestinationRuntimeRegistry,
  PtyOwnershipTransferWorkspaceSurfaceTarget
} from './pty-ownership-transfer-destination-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const leafId = '11111111-1111-4111-8111-111111111111'
const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
} as const
const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId,
  ptyId: identity.terminalId
}
const prepareResult: PtyOwnershipTransferPrepareResult = {
  ...identity,
  version: 1,
  phase: 'prepared',
  sourceOutputEndSeq: 2,
  replayStartSeq: 1,
  surfacePublication: { version: 1, surfaceBinding }
}
const commitReceipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'commit-1',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 2,
  committedAt: '2026-08-30T12:01:00.000Z'
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-destination-runtime-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('PtyOwnershipTransferDestinationRuntimeRegistry', () => {
  it('constructs the durable adapter/store/publication path and recovers it after restart', () => {
    const store = createStore()
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store,
      publishPostCommitOutput: vi.fn()
    })
    const prepared = first.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    const publicationReceipt = prepared.adapter.publish()

    expect(store.inspectPtyOwnershipTransferSurface(publicationRequest(publicationReceipt))).toBe(
      'published'
    )
    expect(store.getWorkspaceSession().tabsByWorktree['folder:folder-1']).toEqual([
      expect.objectContaining({ id: surfaceBinding.tabId, ptyId: surfaceBinding.ptyId })
    ])
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId[surfaceBinding.tabId]
        ?.scrollbackRefsByLeafId?.[leafId]
    expect(ref && store.readTerminalScrollbackSnapshot(ref)).toBe('first\nsecond\n')

    const recoveredStore = createStore()
    const recovered = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: recoveredStore,
      publishPostCommitOutput: vi.fn()
    })
    const recoveredTransfer = recovered.prepare(prepareResult)
    expect(recoveredTransfer.snapshot.phase).toBe('published')
    expect(recoveredTransfer.adapter.publish()).toEqual(publicationReceipt)
    expect(
      recoveredStore.inspectPtyOwnershipTransferSurface(publicationRequest(publicationReceipt))
    ).toBe('published')
  })

  it('completes a binding-only crash retry and rejects another publication identity', () => {
    const store = createStore()
    expect(
      store.persistPtyBinding({
        worktreeId: 'folder:folder-1',
        tabId: surfaceBinding.tabId,
        leafId,
        ptyId: surfaceBinding.ptyId,
        incarnationId: identity.incarnationId,
        bindingMode: 'strict-transfer-publication'
      })
    ).toBe(true)
    const target = new PtyOwnershipTransferWorkspaceSurfaceTarget(store)
    const request = publicationRequest(publicationReceipt())

    expect(target.inspectDurablePublication(request)).toBe('absent')
    target.publishDurably(request)
    expect(target.inspectDurablePublication(request)).toBe('published')

    const changed = publicationRequest({
      ...request.publicationReceipt,
      publicationReceiptId: 'publication-other'
    })
    expect(target.inspectDurablePublication(changed)).toBe('conflict')
    expect(() => target.publishDurably(changed)).toThrow('pty_ownership_transfer_surface_conflict')
  })

  it('fails closed when a transfer names another destination runtime', () => {
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: 'runtime-other',
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    expect(() => registry.prepare(prepareResult)).toThrow(
      'pty_ownership_transfer_destination_runtime_mismatch'
    )
  })

  it('surfaces prior-runtime recovery candidates without adopting their authority', () => {
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    first.prepare(prepareResult)

    const replacement = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: 'runtime-replacement',
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    expect(replacement.listRecoveryCandidates()).toEqual([
      {
        journal: expect.objectContaining({
          bridgeId: identity.bridgeId,
          destinationRuntimeId: identity.destinationRuntimeId,
          phase: 'prepared'
        }),
        surfaceBinding: null
      }
    ])
    expect(replacement.get(identity.bridgeId)).toBeNull()
  })

  it('reopens same-runtime durable sessions after a process restart', () => {
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    first.prepare(prepareResult)

    const replacement = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    const recovered = replacement.recoverPersistedAdapters()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      phase: 'prepared'
    })
    expect(replacement.get(identity.bridgeId)?.snapshot()).toMatchObject({
      identity,
      phase: 'prepared'
    })
  })

  it('rehydrates matching durable adapters without claiming source execution', () => {
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    first.prepare(prepareResult)

    const restarted = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    const hydrated = restarted.recoverPersistedAdapters()

    expect(hydrated).toHaveLength(1)
    expect(hydrated[0]?.snapshot).toMatchObject({
      phase: 'prepared',
      identity,
      executionVerdict: 'unverifiable'
    })
    expect(restarted.get(identity.bridgeId)).toBe(hydrated[0]?.adapter)
  })

  it('reopens a prepared transfer when its output outbox already exists', () => {
    const store = createStore()
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store,
      publishPostCommitOutput: vi.fn()
    })
    expect(first.prepare(prepareResult).snapshot.phase).toBe('prepared')

    const recovered = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    expect(recovered.prepare(prepareResult).snapshot.phase).toBe('prepared')
  })

  it('does not durably expose a binding when the atomic profile flush fails', () => {
    const store = createStore()
    const target = new PtyOwnershipTransferWorkspaceSurfaceTarget(store)
    const request = publicationRequest(publicationReceipt())
    const flush = vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('simulated_profile_flush_failure')
    })

    expect(() => target.publishDurably(request)).toThrow('simulated_profile_flush_failure')
    expect(target.inspectDurablePublication(request)).toBe('absent')
    expect(store.getWorkspaceSession().tabsByWorktree['folder:folder-1']).toBeUndefined()
    expect(
      new PtyOwnershipTransferWorkspaceSurfaceTarget(createStore()).inspectDurablePublication(
        request
      )
    ).toBe('absent')

    flush.mockRestore()
    target.publishDurably(request)
    expect(target.inspectDurablePublication(request)).toBe('published')
  })

  it('durably replaces the exact published surface artifact with an idempotent model checkpoint', () => {
    const store = createStore()
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store,
      publishPostCommitOutput: vi.fn()
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    const receipt = prepared.adapter.publish()
    const checkpoint = {
      identity,
      surfaceBinding,
      publicationReceipt: receipt,
      modelData: 'durable terminal model\n'
    }

    store.checkpointPtyOwnershipTransferTerminalModel(checkpoint)
    store.checkpointPtyOwnershipTransferTerminalModel(checkpoint)

    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId[surfaceBinding.tabId]
        ?.scrollbackRefsByLeafId?.[leafId]
    expect(ref && store.readTerminalScrollbackSnapshot(ref)).toBe(checkpoint.modelData)
    expect(store.inspectPtyOwnershipTransferSurface(publicationRequest(receipt))).toBe('published')
    expect(() =>
      store.checkpointPtyOwnershipTransferTerminalModel({
        ...checkpoint,
        identity: { ...identity, incarnationId: 'stale-incarnation' }
      })
    ).toThrow('orcad_terminal_layout_reservation_identity_conflict')
    expect(ref && store.readTerminalScrollbackSnapshot(ref)).toBe(checkpoint.modelData)

    store.getWorkspaceSession().terminalLayoutsByTabId[surfaceBinding.tabId].buffersByLeafId = {
      [leafId]: 'unrelated local output'
    }
    expect(() => store.checkpointPtyOwnershipTransferTerminalModel(checkpoint)).toThrow(
      'pty_ownership_transfer_model_checkpoint_conflict'
    )
    expect(ref && store.readTerminalScrollbackSnapshot(ref)).toBe(checkpoint.modelData)
  })

  it('queues post-commit output durably before publication and acknowledges after success', () => {
    const publish = vi
      .fn<
        (
          identity: PtyOwnershipTransferWireIdentity,
          binding: PtyOwnershipTransferSurfaceBinding,
          frame: { seq: number; data: string }
        ) => void
      >()
      .mockImplementationOnce(() => {
        throw new Error('surface_temporarily_unavailable')
      })
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: publish
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)

    expect(() => prepared.adapter.acceptPostCommitOutput({ seq: 3, data: 'live\n' })).toThrow(
      'surface_temporarily_unavailable'
    )
    expect(registry.pendingPostCommitOutput(prepareResult)?.pendingFrames).toEqual([
      { seq: 3, data: 'live\n' }
    ])

    prepared.adapter.acceptPostCommitOutput({ seq: 3, data: 'live\n' })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(registry.pendingPostCommitOutput(prepareResult)?.pendingFrames).toEqual([])
  })

  it('replays a durably queued frame after registry restart', () => {
    const store = createStore()
    const firstPublish = vi.fn(() => {
      throw new Error('surface_temporarily_unavailable')
    })
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store,
      publishPostCommitOutput: firstPublish
    })
    const prepared = first.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    expect(() => prepared.adapter.acceptPostCommitOutput({ seq: 3, data: 'live\n' })).toThrow()

    const replayed: { seq: number; data: string }[] = []
    const recovered = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: (_identity, _binding, frame) => replayed.push(frame)
    })
    const recoveredTransfer = recovered.prepare(prepareResult)
    expect(recovered.replayPendingPostCommitOutput(prepareResult)).toBe(1)
    expect(replayed).toEqual([{ seq: 3, data: 'live\n' }])
    expect(recovered.pendingPostCommitOutput(prepareResult)?.pendingFrames).toEqual([])
    expect(recoveredTransfer.adapter.snapshot()).toMatchObject({
      phase: 'committed',
      liveOutputEndSeq: 3
    })
  })

  it('restores an acknowledged post-commit cursor after registry restart', () => {
    const store = createStore()
    const published: { seq: number; data: string }[] = []
    const first = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store,
      publishPostCommitOutput: (_identity, _binding, frame) => published.push(frame)
    })
    const prepared = first.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    prepared.adapter.publish()
    prepared.adapter.acceptPostCommitOutput({ seq: 3, data: 'live\n' })

    const recovered = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: (_identity, _binding, frame) => published.push(frame)
    })
    const recoveredTransfer = recovered.prepare(prepareResult)
    expect(recoveredTransfer.adapter.snapshot()).toMatchObject({
      phase: 'published',
      liveOutputEndSeq: 3
    })

    recoveredTransfer.adapter.acceptPostCommitOutput({ seq: 4, data: 'after restart\n' })
    expect(published).toEqual([
      { seq: 3, data: 'live\n' },
      { seq: 4, data: 'after restart\n' }
    ])
  })

  it('routes a complete received frame through the registry identity fence', () => {
    const publish = vi.fn()
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: publish
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)

    registry.acceptPostCommitOutput(identity, { seq: 3, data: 'live\n' })
    expect(publish).toHaveBeenCalledWith(identity, surfaceBinding, { seq: 3, data: 'live\n' })
    expect(() =>
      registry.acceptPostCommitOutput({ ...identity, ownerLease: 'stale' }, { seq: 4, data: 'bad' })
    ).toThrow('pty_ownership_transfer_destination_identity_mismatch')
  })

  it('defers live output until its reserved attachment is accepted', async () => {
    const publish = vi.fn()
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: publish
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true
    }
    let emitOutput:
      | ((event: {
          identity: PtyOwnershipTransferWireIdentity
          attachmentId: string
          frame: PtyOwnershipTransferOutputFrame
        }) => void | Promise<void>)
      | undefined
    const source = {
      onDestinationOutput: vi.fn(
        (
          _capabilities: PtyOwnershipBridgeCapabilities,
          _identity: PtyOwnershipTransferWireIdentity,
          _attachmentId: string,
          callback: NonNullable<typeof emitOutput>
        ) => {
          emitOutput = callback
          return vi.fn()
        }
      )
    }
    const reservation = prepared.adapter.reserveExecutionAttachment('attachment-raced')
    const dispose = registry.watchDestinationOutput(
      source,
      capabilities,
      identity,
      'attachment-raced',
      prepared.adapter,
      reservation
    )

    const outputAccepted = emitOutput?.({
      identity,
      attachmentId: 'attachment-raced',
      frame: { seq: 3, data: 'live during attach\n' }
    })
    let accepted = false
    void outputAccepted?.then(() => {
      accepted = true
    })
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    expect(accepted).toBe(false)

    registry.acceptDestinationAttachment(
      {
        ...identity,
        version: 1,
        phase: 'committed',
        attachmentId: 'attachment-raced',
        executionVerdict: 'live'
      },
      reservation
    )

    await expect(outputAccepted).resolves.toBeUndefined()

    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledWith(identity, surfaceBinding, {
        seq: 3,
        data: 'live during attach\n'
      })
    })
    expect(prepared.adapter.snapshot()).toMatchObject({
      attachmentId: 'attachment-raced',
      liveOutputEndSeq: 3
    })
    dispose()
  })

  it('stages post-commit output durably without publishing until acceptance', () => {
    const publish = vi.fn()
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: publish
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)

    registry.stagePostCommitOutput(identity, { seq: 3, data: 'live\n' })
    expect(publish).not.toHaveBeenCalled()
    expect(registry.pendingPostCommitOutput(identity)?.pendingFrames).toEqual([
      { seq: 3, data: 'live\n' }
    ])

    registry.acceptPostCommitOutput(identity, { seq: 3, data: 'live\n' })
    expect(publish).toHaveBeenCalledWith(identity, surfaceBinding, { seq: 3, data: 'live\n' })
    expect(registry.pendingPostCommitOutput(identity)?.pendingFrames).toEqual([])
  })

  it('retains staged output when a model checkpoint fails and retries later', async () => {
    const publish = vi.fn()
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: publish
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)

    registry.stagePostCommitOutput(identity, { seq: 3, data: 'live\n' })
    const failedCheckpoint = Promise.reject(new Error('model_checkpoint_failed'))
    await expect(failedCheckpoint).rejects.toThrow('model_checkpoint_failed')
    expect(publish).not.toHaveBeenCalled()
    expect(registry.pendingPostCommitOutput(identity)?.pendingFrames).toEqual([
      { seq: 3, data: 'live\n' }
    ])

    registry.acceptPostCommitOutput(identity, { seq: 3, data: 'live\n' })
    expect(publish).toHaveBeenCalledOnce()
    expect(registry.pendingPostCommitOutput(identity)?.pendingFrames).toEqual([])
  })

  it('attaches authoritative source exit evidence to the exact destination adapter', () => {
    let onExit:
      | ((event: {
          bridgeId: string
          terminalId: string
          incarnationId: string
          ownerLease: string
          sourceOwnerGeneration: number
          destinationRuntimeId: string
          version: 1
          attachmentId: string
          exit: { verdict: 'exited'; eventId: string; observedAt: string; code?: number }
        }) => void)
      | undefined
    const source = {
      onDestinationExit: vi.fn((_capabilities, callback) => {
        onExit = callback
        return vi.fn()
      })
    }
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true
    } as const
    const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      store: createStore(),
      publishPostCommitOutput: vi.fn()
    })
    const prepared = registry.prepare(prepareResult)
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...prepareResult,
      frames: [
        { seq: 1, data: 'first\n' },
        { seq: 2, data: 'second\n' }
      ]
    })
    prepared.adapter.commit(commitReceipt)
    const reservation = prepared.adapter.reserveExecutionAttachment('attachment-1')
    prepared.adapter.attachExecution(
      {
        ...identity,
        version: 1,
        phase: 'committed',
        attachmentId: 'attachment-1',
        executionVerdict: 'live'
      },
      reservation
    )

    const dispose = registry.watchDestinationExit(source, capabilities, prepared.adapter)
    expect(source.onDestinationExit).toHaveBeenCalledWith(capabilities, expect.any(Function))
    onExit?.({
      ...identity,
      version: 1,
      attachmentId: 'attachment-1',
      exit: {
        verdict: 'exited',
        eventId: 'exit-1',
        observedAt: '2026-08-31T12:00:00.000Z',
        code: 0
      }
    })
    expect(prepared.adapter.snapshot()).toMatchObject({
      executionVerdict: 'exited',
      exit: { eventId: 'exit-1', code: 0 }
    })

    dispose()
    onExit?.({
      ...identity,
      version: 1,
      attachmentId: 'attachment-1',
      exit: {
        verdict: 'exited',
        eventId: 'exit-2',
        observedAt: '2026-08-31T12:00:01.000Z'
      }
    })
    expect(prepared.adapter.snapshot().exit?.eventId).toBe('exit-1')
  })
})

function publicationReceipt(): PtyOwnershipTransferDestinationPublicationRequest['publicationReceipt'] {
  return {
    version: 1 as const,
    publicationReceiptId: 'publication-1',
    bridgeId: identity.bridgeId,
    destinationRuntimeId: identity.destinationRuntimeId,
    commitReceipt,
    publishedAt: '2026-08-30T12:02:00.000Z',
    surfaceBinding
  }
}

function publicationRequest(
  receipt: ReturnType<typeof publicationReceipt>
): PtyOwnershipTransferDestinationPublicationRequest {
  return {
    identity,
    surfaceBinding,
    frames: [
      { seq: 1, data: 'first\n' },
      { seq: 2, data: 'second\n' }
    ],
    publicationReceipt: receipt
  }
}
