import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PtyOwnershipTransferCommitRequest,
  PtyOwnershipTransferExitEvent,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferPublishRequest,
  PtyOwnershipTransferReplayResult
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import { createStore, testState } from '../../persistence-test-harness'
import { PtyOwnershipTransferCoordinator } from './pty-ownership-transfer-coordinator'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
}
const surfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: identity.terminalId
} as const

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-coordinator-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('PtyOwnershipTransferCoordinator', () => {
  it('fences, drains replay, commits, and publishes an exact destination surface', async () => {
    const source = createSource()
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
      createReceiptId: () => 'commit-1'
    })

    const result = await coordinator.transfer()

    expect(source.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeId: identity.bridgeId,
        surfacePublication: { version: 1, surfaceBinding }
      }),
      expect.any(Object)
    )
    expect(source.replay).toHaveBeenCalledTimes(2)
    expect(source.replay.mock.calls.map(([request]) => request.afterSeq)).toEqual([0, 2])
    expect(source.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedSourceEndSeq: 2,
        receipt: expect.objectContaining({ receiptId: 'commit-1' })
      }),
      expect.any(Object)
    )
    expect(source.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationReceipt: expect.objectContaining({ bridgeId: identity.bridgeId })
      }),
      expect.any(Object)
    )
    expect(result.destination.snapshot()).toMatchObject({
      phase: 'published',
      acceptedSourceEndSeq: 2
    })
  })

  it('binds a negotiated destination attachment before source commit', async () => {
    const baseSource = createSource()
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
    const attachDestination = vi.fn(async () => ({
      ...identity,
      version: 1 as const,
      phase: 'prepared' as const,
      attachmentId: 'attachment-1',
      executionVerdict: 'live' as const
    }))
    const onDestinationOutput = vi.fn(() => vi.fn())
    const source = { ...baseSource, attachDestination, onDestinationOutput }
    const registry = createRegistry()
    const watchDestinationOutput = vi.spyOn(registry, 'watchDestinationOutput')
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      destinationCapabilities: capabilities,
      createAttachmentId: () => 'attachment-1'
    })

    const result = await coordinator.transfer()

    expect(attachDestination).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'attachment-1' }),
      capabilities,
      expect.any(Object)
    )
    expect(attachDestination.mock.invocationCallOrder[0]).toBeLessThan(
      baseSource.commit.mock.invocationCallOrder[0]
    )
    expect(watchDestinationOutput.mock.calls[0]?.[5]).toBeDefined()
    expect(result.destination.snapshot()).toMatchObject({
      attachmentId: 'attachment-1',
      executionVerdict: 'live'
    })
  })

  it('settles exit evidence emitted before the attachment response', async () => {
    const baseSource = createSource()
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
    let emitExit: ((event: PtyOwnershipTransferExitEvent) => void) | undefined
    const source = {
      ...baseSource,
      onDestinationExit: vi.fn(
        (
          _capabilities: PtyOwnershipBridgeCapabilities,
          callback: (event: PtyOwnershipTransferExitEvent) => void
        ) => {
          emitExit = callback
          return vi.fn()
        }
      ),
      attachDestination: vi.fn(async () => {
        emitExit?.({
          ...identity,
          version: 1,
          attachmentId: 'attachment-raced',
          exit: {
            verdict: 'exited',
            eventId: 'exit-before-attach-response',
            observedAt: '2026-08-31T12:00:01.000Z',
            code: 0
          }
        })
        return {
          ...identity,
          version: 1 as const,
          phase: 'prepared' as const,
          attachmentId: 'attachment-raced',
          executionVerdict: 'live' as const
        }
      })
    }
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: createRegistry(),
      identity,
      surfaceBinding,
      destinationCapabilities: capabilities,
      createAttachmentId: () => 'attachment-raced'
    })

    const result = await coordinator.transfer()

    expect(source.onDestinationExit.mock.invocationCallOrder[0]).toBeLessThan(
      source.attachDestination.mock.invocationCallOrder[0]
    )
    expect(result.destination.snapshot()).toMatchObject({
      attachmentId: 'attachment-raced',
      executionVerdict: 'exited',
      exit: { eventId: 'exit-before-attach-response', code: 0 }
    })
  })

  it('aborts both sides when replay cannot quiesce within the bound', async () => {
    const source = createSource({ alwaysGrowing: true })
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      maxReplayPasses: 2
    })

    await expect(coordinator.transfer()).rejects.toThrow(
      'pty_ownership_transfer_replay_did_not_quiesce'
    )
    expect(source.abort).toHaveBeenCalledTimes(1)
    expect(registry.get(identity.bridgeId)?.snapshot().phase).toBe('aborted')
  })

  it('keeps the source fenced when destination commit is durable but source commit is unavailable', async () => {
    const source = createSource({ failCommit: true })
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding
    })

    await expect(coordinator.transfer()).rejects.toThrow('source_commit_unavailable')
    expect(source.abort).not.toHaveBeenCalled()
    expect(registry.get(identity.bridgeId)?.snapshot().phase).toBe('committed')
  })

  it('fails closed when the source acknowledges a different commit receipt', async () => {
    const source = createSource({ mismatchedCommitReceipt: true })
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      createReceiptId: () => 'commit-1'
    })

    await expect(coordinator.transfer()).rejects.toThrow(
      'pty_ownership_transfer_commit_receipt_mismatch'
    )
    expect(source.abort).not.toHaveBeenCalled()
    expect(registry.get(identity.bridgeId)?.snapshot().phase).toBe('committed')
  })

  it('fails closed when the source acknowledges a different publication receipt', async () => {
    const source = createSource({ mismatchedPublicationReceipt: true })
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      createReceiptId: () => 'commit-1'
    })

    await expect(coordinator.transfer()).rejects.toThrow(
      'pty_ownership_transfer_publication_receipt_mismatch'
    )
    expect(source.abort).not.toHaveBeenCalled()
    expect(registry.get(identity.bridgeId)?.snapshot().phase).toBe('published')
  })

  it('refuses a pruned replay window until a terminal-model baseline exists', async () => {
    const source = createSource({ replayStartSeq: 2 })
    const registry = createRegistry()
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding
    })

    await expect(coordinator.transfer()).rejects.toThrow(
      'pty_ownership_transfer_baseline_unavailable'
    )
    expect(source.commit).not.toHaveBeenCalled()
    expect(source.abort).toHaveBeenCalledTimes(1)
  })

  it('recovers a committed destination without replaying prepared output', async () => {
    const registry = createRegistry()
    const commitReceipt = {
      receiptId: 'commit-1',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 2,
      committedAt: '2026-08-31T12:00:00.000Z'
    }
    const prepared = registry.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding }
    })
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...identity,
      version: 1,
      phase: 'prepared',
      frames: [
        { seq: 1, data: 'one\n' },
        { seq: 2, data: 'two\n' }
      ],
      sourceOutputEndSeq: 2,
      replayStartSeq: 1
    })
    prepared.adapter.commit(commitReceipt)

    const source = {
      ...createSource(),
      status: vi.fn(async () => ({
        ...identity,
        version: 1 as const,
        phase: 'committed' as const,
        sourceOutputEndSeq: 2,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 2,
        acceptedInputIds: 0,
        commitReceipt,
        surfacePublication: { version: 1 as const, surfaceBinding }
      }))
    }
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding
    })

    const recovered = await coordinator.recover()

    expect(source.replay).not.toHaveBeenCalled()
    expect(source.status).toHaveBeenCalledTimes(1)
    expect(source.publish).toHaveBeenCalledTimes(1)
    expect(recovered.published).toBe(true)
    expect(recovered.destination?.snapshot()).toMatchObject({ phase: 'published' })
  })

  it('does not replay or publish when recovery sees a prepared source', async () => {
    const source = {
      ...createSource(),
      status: vi.fn(async () => ({
        ...identity,
        version: 1 as const,
        phase: 'prepared' as const,
        sourceOutputEndSeq: 2,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 0,
        acceptedInputIds: 0,
        surfacePublication: { version: 1 as const, surfaceBinding }
      }))
    }
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: createRegistry(),
      identity,
      surfaceBinding
    })

    const recovered = await coordinator.recover()

    expect(recovered.published).toBe(false)
    expect(source.replay).not.toHaveBeenCalled()
    expect(source.publish).not.toHaveBeenCalled()
  })

  it('reuses a durable destination publication receipt after a lost source publish response', async () => {
    const registry = createRegistry()
    const commitReceipt = {
      receiptId: 'commit-1',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 2,
      committedAt: '2026-08-31T12:00:00.000Z'
    }
    const prepared = registry.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding }
    })
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...identity,
      version: 1,
      phase: 'prepared',
      frames: [
        { seq: 1, data: 'one\n' },
        { seq: 2, data: 'two\n' }
      ],
      sourceOutputEndSeq: 2,
      replayStartSeq: 1
    })
    prepared.adapter.commit(commitReceipt)
    const publicationReceipt = prepared.adapter.publish()

    const source = {
      ...createSource(),
      status: vi.fn(async () => ({
        ...identity,
        version: 1 as const,
        phase: 'committed' as const,
        sourceOutputEndSeq: 2,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 2,
        acceptedInputIds: 0,
        commitReceipt,
        surfacePublication: { version: 1 as const, surfaceBinding }
      }))
    }
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding
    })

    const recovered = await coordinator.recover()

    expect(source.publish).toHaveBeenCalledWith(
      expect.objectContaining({ publicationReceipt }),
      expect.any(Object)
    )
    expect(recovered.published).toBe(true)
    expect(recovered.destination?.snapshot()).toMatchObject({
      phase: 'published',
      publicationReceipt
    })
  })

  it('reattaches a durable destination after recovery when routing is negotiated', async () => {
    const registry = createRegistry()
    const commitReceipt = {
      receiptId: 'commit-reattach',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 2,
      committedAt: '2026-08-31T12:00:00.000Z'
    }
    const prepared = registry.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      replayStartSeq: 1,
      surfacePublication: { version: 1, surfaceBinding }
    })
    prepared.adapter.bindSurface(surfaceBinding)
    prepared.adapter.acceptReplay({
      ...identity,
      version: 1,
      phase: 'prepared',
      frames: [
        { seq: 1, data: 'one\n' },
        { seq: 2, data: 'two\n' }
      ],
      sourceOutputEndSeq: 2,
      replayStartSeq: 1
    })
    prepared.adapter.commit(commitReceipt)
    const publicationReceipt = prepared.adapter.publish()
    const capabilities = {
      protocolVersions: [1],
      maxReplayBytes: 1024,
      maxInputIds: 32,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true
    } as const
    const attachDestination = vi.fn(async () => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      attachmentId: 'attachment-recovered',
      executionVerdict: 'live' as const
    }))
    const source = {
      ...createSource(),
      status: vi.fn(async () => ({
        ...identity,
        version: 1 as const,
        phase: 'published' as const,
        sourceOutputEndSeq: 2,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 2,
        acceptedInputIds: 0,
        commitReceipt,
        publicationReceipt,
        surfacePublication: { version: 1 as const, surfaceBinding }
      })),
      attachDestination
    }
    const coordinator = new PtyOwnershipTransferCoordinator({
      source,
      destination: registry,
      identity,
      surfaceBinding,
      getDestinationCapabilities: vi.fn(async () => capabilities),
      createAttachmentId: () => 'attachment-recovered'
    })

    const recovered = await coordinator.recover()

    expect(attachDestination).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'attachment-recovered' }),
      capabilities,
      expect.any(Object)
    )
    expect(recovered.destination?.snapshot()).toMatchObject({
      phase: 'published',
      attachmentId: 'attachment-recovered',
      executionVerdict: 'live'
    })
  })
})

function createRegistry(): PtyOwnershipTransferDestinationRuntimeRegistry {
  return new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store: createStore(),
    publishPostCommitOutput: vi.fn()
  })
}

function createSource(
  options: {
    alwaysGrowing?: boolean
    failCommit?: boolean
    mismatchedCommitReceipt?: boolean
    mismatchedPublicationReceipt?: boolean
    replayStartSeq?: number
  } = {}
) {
  const prepareResult: PtyOwnershipTransferPrepareResult = {
    ...identity,
    version: 1,
    phase: 'prepared',
    sourceOutputEndSeq: 2,
    replayStartSeq: options.replayStartSeq ?? 1,
    surfacePublication: { version: 1, surfaceBinding }
  }
  const prepare = vi.fn(async () => prepareResult)
  const replay = vi.fn(
    async (request: {
      afterSeq: number
      attachmentId?: string
    }): Promise<PtyOwnershipTransferReplayResult> => {
      const end = options.alwaysGrowing ? request.afterSeq + 1 : 2
      const frames = options.alwaysGrowing
        ? [{ seq: end, data: `frame-${end}\n` }]
        : request.afterSeq < 1
          ? [
              { seq: 1, data: 'first\n' },
              { seq: 2, data: 'second\n' }
            ]
          : []
      return {
        ...identity,
        version: 1,
        phase: request.attachmentId ? 'published' : 'prepared',
        frames,
        sourceOutputEndSeq: end,
        replayStartSeq: 1,
        ...(request.attachmentId ? { attachmentId: request.attachmentId } : {})
      }
    }
  )
  const commit = vi.fn(async (request: Pick<PtyOwnershipTransferCommitRequest, 'receipt'>) => {
    if (options.failCommit) {
      throw new Error('source_commit_unavailable')
    }
    const receipt = options.mismatchedCommitReceipt
      ? { ...request.receipt, receiptId: 'different-commit' }
      : request.receipt
    return {
      ...identity,
      version: 1 as const,
      phase: 'committed' as const,
      receipt
    }
  })
  const publish = vi.fn(
    async (request: Pick<PtyOwnershipTransferPublishRequest, 'publicationReceipt'>) => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      publicationReceipt: options.mismatchedPublicationReceipt
        ? { ...request.publicationReceipt, publicationReceiptId: 'different-publication' }
        : request.publicationReceipt
    })
  )
  const abort = vi.fn(async () => ({ version: 1 as const, phase: 'aborted' as const }))
  return { prepare, replay, commit, publish, abort }
}
