import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-journal-contract'
import type {
  PtyOwnershipTransferPublishRequest,
  PtyOwnershipTransferReplayRequest,
  PtyOwnershipTransferReplayResult,
  PtyOwnershipTransferExitEvent
} from '../../../shared/pty-ownership-transfer-wire'
import { createStore, testState } from '../../persistence-test-harness'
import { PtyOwnershipTransferCoordinator } from './pty-ownership-transfer-coordinator'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const identity = {
  bridgeId: 'bridge-recovery',
  terminalId: 'terminal-recovery',
  incarnationId: 'incarnation-recovery',
  ownerLease: 'lease-recovery',
  sourceOwnerGeneration: 4,
  destinationRuntimeId: 'runtime-recovery'
} as const
const surfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: identity.terminalId
} as const
const capabilities: PtyOwnershipBridgeCapabilities = {
  protocolVersions: [1],
  maxReplayBytes: 128 * 1024,
  maxInputIds: 4096,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true,
  postCommitReplay: true
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-recovery-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('PtyOwnershipTransferCoordinator recovery attachment', () => {
  it('replays the durable cursor before attaching and drains concurrently staged live output', async () => {
    const events: string[] = []
    const published: { seq: number; data: string }[] = []
    let concurrentAdmission: Promise<void> | undefined
    const registry = createRegistry((frame) => {
      events.push(`output-${frame.seq}`)
      published.push(frame)
    })
    const { adapter, publicationReceipt } = preparePublishedDestination(registry)
    const attachExecution = adapter.attachExecution.bind(adapter)
    vi.spyOn(adapter, 'attachExecution').mockImplementation((result, reservation) => {
      events.push('attach-execution')
      return attachExecution(result, reservation)
    })
    const source = createRecoveredSource(publicationReceipt, {
      attach: () => events.push('attach'),
      replay: (request) => {
        events.push('replay')
        registry.stagePostCommitOutput(identity, { seq: 5, data: 'five\n' })
        concurrentAdmission = registry
          .acceptPostCommitOutputAfterAttachment(identity, { seq: 5, data: 'five\n' })
          .then(() => {
            events.push('source-credit-settled')
          })
        return {
          ...identity,
          version: 1 as const,
          phase: 'published' as const,
          attachmentId: request.attachmentId,
          frames: [
            { seq: 3, data: 'three\n' },
            { seq: 4, data: 'four\n' }
          ],
          sourceOutputEndSeq: 4,
          replayStartSeq: 1
        }
      }
    })
    const coordinator = createCoordinator(registry, source, capabilities)

    const recovered = await coordinator.recover()
    await concurrentAdmission

    expect(source.replay).toHaveBeenCalledWith(
      expect.objectContaining({ afterSeq: 2, attachmentId: 'attachment-recovered' }),
      expect.any(Object)
    )
    expect(events).toEqual([
      'attach',
      'replay',
      'output-3',
      'output-4',
      'attach-execution',
      'output-5',
      'source-credit-settled'
    ])
    expect(published).toEqual([
      { seq: 3, data: 'three\n' },
      { seq: 4, data: 'four\n' },
      { seq: 5, data: 'five\n' }
    ])
    expect(recovered.destination?.snapshot()).toMatchObject({
      phase: 'published',
      liveOutputEndSeq: 5,
      attachmentId: 'attachment-recovered',
      executionVerdict: 'live'
    })
  })

  it('drains multiple out-of-order live frames through one cumulative recovery barrier', async () => {
    const events: string[] = []
    const published: number[] = []
    const registry = createRegistry((frame) => {
      events.push(`output-${frame.seq}`)
      published.push(frame.seq)
    })
    const { publicationReceipt } = preparePublishedDestination(registry)
    let admissions: Promise<void>[] = []
    const source = createRecoveredSource(publicationReceipt, {
      attach: () => events.push('attach'),
      replay: (request) => {
        events.push('replay')
        if (request.attachmentId) {
          // Source output races replay; admission must settle cumulatively and publish once.
          const liveFrames = [
            { seq: 7, data: 'seven\n' },
            { seq: 5, data: 'five\n' },
            { seq: 6, data: 'six\n' },
            { seq: 7, data: 'seven\n' }
          ]
          admissions = liveFrames.map((frame) => {
            registry.stagePostCommitOutput(identity, frame)
            return registry.acceptPostCommitOutputAfterAttachment(identity, frame)
          })
        }
        return {
          ...identity,
          version: 1 as const,
          phase: 'published' as const,
          attachmentId: request.attachmentId,
          frames: [
            { seq: 3, data: 'three\n' },
            { seq: 4, data: 'four\n' },
            { seq: 5, data: 'five\n' },
            { seq: 6, data: 'six\n' },
            { seq: 7, data: 'seven\n' }
          ],
          sourceOutputEndSeq: 7,
          replayStartSeq: 1
        }
      }
    })
    const coordinator = createCoordinator(registry, source, capabilities)

    const recovered = await coordinator.recover()
    await Promise.all(admissions)

    expect(events).toEqual([
      'attach',
      'replay',
      'output-3',
      'output-4',
      'output-5',
      'output-6',
      'output-7'
    ])
    expect(published).toEqual([3, 4, 5, 6, 7])
    expect(registry.pendingPostCommitOutput(identity)).toMatchObject({
      acknowledgedEndSeq: 7,
      pendingFrames: []
    })
    expect(recovered.destination?.snapshot()).toMatchObject({
      phase: 'published',
      liveOutputEndSeq: 7,
      attachmentId: 'attachment-recovered',
      executionVerdict: 'live'
    })
  })

  it('atomically rekeys the durable relay route before reconnect replay', async () => {
    const registry = createRegistry()
    const { publicationReceipt } = preparePublishedDestination(registry)
    const source = {
      ...createRecoveredSource(publicationReceipt),
      rekeyReconnect: vi.fn(async (request) => ({
        ...request,
        phase: 'published' as const,
        executionVerdict: 'live' as const
      }))
    }
    const coordinator = createCoordinator(
      registry,
      source,
      { ...capabilities, reconnectRekey: true },
      { getReconnectGeneration: () => 5 }
    )

    const recovered = await coordinator.recover()

    expect(source.rekeyReconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        previousReconnectGeneration: 4,
        reconnectGeneration: 5,
        attachmentId: 'attachment-recovered'
      }),
      expect.objectContaining({ reconnectRekey: true }),
      expect.any(Object)
    )
    expect(source.attachDestination).not.toHaveBeenCalled()
    expect(source.replay).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'attachment-recovered' }),
      expect.any(Object)
    )
    expect(recovered.destination?.snapshot()).toMatchObject({
      attachmentId: 'attachment-recovered',
      executionVerdict: 'live'
    })
  })

  it('does not fall back to ordinary attach when negotiated rekey authority is unavailable', async () => {
    const registry = createRegistry()
    const { publicationReceipt } = preparePublishedDestination(registry)
    const source = createRecoveredSource(publicationReceipt)
    const coordinator = createCoordinator(registry, source, {
      ...capabilities,
      reconnectRekey: true
    })

    await expect(coordinator.recover()).rejects.toThrow(
      'pty_ownership_transfer_recovery_reconnect_rekey_unavailable'
    )
    expect(source.attachDestination).not.toHaveBeenCalled()
    expect(source.replay).not.toHaveBeenCalled()
  })

  it('fails closed before attachment when post-commit replay is not negotiated', async () => {
    const registry = createRegistry()
    const { adapter, publicationReceipt } = preparePublishedDestination(registry)
    const source = createRecoveredSource(publicationReceipt)
    const coordinator = createCoordinator(registry, source, {
      ...capabilities,
      postCommitReplay: false
    })

    await expect(coordinator.recover()).rejects.toThrow(
      'pty_ownership_transfer_recovery_post_commit_replay_unsupported'
    )
    expect(source.attachDestination).not.toHaveBeenCalled()
    expect(source.replay).not.toHaveBeenCalled()
    expect(adapter.snapshot().attachmentId).toBeUndefined()
    expect(adapter.snapshot().executionVerdict).toBe('unverifiable')
  })

  it('leaves the destination unverifiable and live output fenced when replay was pruned', async () => {
    const registry = createRegistry()
    const { adapter, publicationReceipt } = preparePublishedDestination(registry)
    const source = createRecoveredSource(publicationReceipt, {
      replay: () => {
        throw new Error('pty_ownership_transfer_replay_unavailable')
      }
    })
    const coordinator = createCoordinator(registry, source, capabilities)

    await expect(coordinator.recover()).rejects.toThrow('pty_ownership_transfer_replay_unavailable')
    expect(source.abort).not.toHaveBeenCalled()
    expect(adapter.snapshot()).toMatchObject({
      phase: 'published',
      executionVerdict: 'unverifiable'
    })
    expect(adapter.snapshot().attachmentId).toBeUndefined()
    expect(() => adapter.acceptPostCommitOutput({ seq: 3, data: 'blocked\n' })).toThrow(
      expect.objectContaining({ reason: 'stale-attachment' })
    )
  })

  it('buffers an authoritative exit emitted between source attachment and destination admission', async () => {
    const registry = createRegistry()
    const { publicationReceipt } = preparePublishedDestination(registry)
    const events: string[] = []
    let emitExit: ((event: PtyOwnershipTransferExitEvent) => void) | undefined
    const baseSource = createRecoveredSource(publicationReceipt, {
      attach: () => events.push('attach'),
      replay: (request) => {
        events.push('replay')
        if (!request.attachmentId) {
          throw new Error('test_attachment_missing')
        }
        emitExit?.({
          ...identity,
          version: 1,
          attachmentId: request.attachmentId,
          exit: {
            verdict: 'exited',
            eventId: 'exit-during-replay',
            observedAt: '2026-08-31T12:00:01.000Z',
            code: 0
          }
        })
        return {
          ...identity,
          version: 1,
          phase: 'published',
          attachmentId: request.attachmentId,
          frames: [
            { seq: 3, data: 'three\n' },
            { seq: 4, data: 'four\n' }
          ],
          sourceOutputEndSeq: 4,
          replayStartSeq: 1
        }
      }
    })
    const source = {
      ...baseSource,
      onDestinationExit: vi.fn(
        (
          _capabilities: PtyOwnershipBridgeCapabilities,
          callback: (event: PtyOwnershipTransferExitEvent) => void
        ) => {
          events.push('subscribe-exit')
          emitExit = callback
          return vi.fn()
        }
      )
    }

    const recovered = await createCoordinator(registry, source, capabilities).recover()

    expect(events.slice(0, 3)).toEqual(['subscribe-exit', 'attach', 'replay'])
    expect(recovered.destination?.snapshot()).toMatchObject({
      executionVerdict: 'exited',
      exit: { eventId: 'exit-during-replay', code: 0 }
    })
  })

  it('awaits paired stream readiness and cleans every watcher on reattach failure', async () => {
    const events: string[] = []
    const disposeExit = vi.fn(() => events.push('dispose-exit'))
    const disposeOutput = vi.fn(() => events.push('dispose-output'))
    const disposeTransportLost = vi.fn(() => events.push('dispose-transport'))
    const registry = createRegistry()
    const { publicationReceipt } = preparePublishedDestination(registry)
    const source = {
      ...createRecoveredSource(publicationReceipt),
      onDestinationExitForAttachment: vi.fn(() => {
        events.push('subscribe-exit')
        return disposeExit
      }),
      onDestinationOutput: vi.fn(() => {
        events.push('subscribe-output')
        return disposeOutput
      }),
      onDestinationTransportLost: vi.fn(() => {
        events.push('subscribe-transport')
        return disposeTransportLost
      }),
      waitForDestinationStreamReady: vi.fn(async () => {
        events.push('ready')
      }),
      attachDestination: vi.fn(async () => {
        events.push('attach')
        throw new Error('reattach-failed')
      })
    }

    await expect(createCoordinator(registry, source, capabilities).recover()).rejects.toThrow(
      'reattach-failed'
    )
    expect(events).toEqual([
      'subscribe-exit',
      'subscribe-output',
      'subscribe-transport',
      'ready',
      'attach',
      'dispose-exit',
      'dispose-output',
      'dispose-transport'
    ])
  })

  it('cleans earlier watchers when a later stream watcher cannot be installed', async () => {
    const disposeExit = vi.fn()
    const registry = createRegistry()
    const { publicationReceipt } = preparePublishedDestination(registry)
    const source = {
      ...createRecoveredSource(publicationReceipt),
      onDestinationExitForAttachment: vi.fn(() => disposeExit),
      onDestinationOutput: vi.fn(() => {
        throw new Error('output-watch-failed')
      })
    }

    await expect(createCoordinator(registry, source, capabilities).recover()).rejects.toThrow(
      'output-watch-failed'
    )
    expect(disposeExit).toHaveBeenCalledOnce()
  })
})

function createRegistry(onOutput: (frame: { seq: number; data: string }) => void = vi.fn()) {
  return new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store: createStore(),
    publishPostCommitOutput: (_identity, _binding, frame) => onOutput(frame)
  })
}

function preparePublishedDestination(registry: PtyOwnershipTransferDestinationRuntimeRegistry) {
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
  prepared.adapter.commit({
    receiptId: 'commit-recovery',
    bridgeId: identity.bridgeId,
    acceptedSourceEndSeq: 2,
    committedAt: '2026-08-31T12:00:00.000Z'
  })
  return { adapter: prepared.adapter, publicationReceipt: prepared.adapter.publish() }
}

function createRecoveredSource(
  publicationReceipt: PtyOwnershipTransferPublicationReceipt,
  hooks: Readonly<{
    attach?: () => void
    replay?: (request: PtyOwnershipTransferReplayRequest) => PtyOwnershipTransferReplayResult
  }> = {}
) {
  const replay = vi.fn(
    async (request: PtyOwnershipTransferReplayRequest): Promise<PtyOwnershipTransferReplayResult> =>
      hooks.replay
        ? hooks.replay(request)
        : {
            ...identity,
            version: 1 as const,
            phase: 'published' as const,
            attachmentId: request.attachmentId,
            frames: [],
            sourceOutputEndSeq: 2,
            replayStartSeq: 1
          }
  )
  return {
    prepare: vi.fn(),
    replay,
    commit: vi.fn(),
    publish: vi.fn(async (request: PtyOwnershipTransferPublishRequest) => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      publicationReceipt: request.publicationReceipt
    })),
    abort: vi.fn(),
    status: vi.fn(async () => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      sourceOutputEndSeq: 4,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 2,
      acceptedInputIds: 0,
      reconnectGeneration: 4,
      commitReceipt: publicationReceipt.commitReceipt,
      publicationReceipt,
      surfacePublication: { version: 1 as const, surfaceBinding }
    })),
    attachDestination: vi.fn(async () => {
      hooks.attach?.()
      return {
        ...identity,
        version: 1 as const,
        phase: 'published' as const,
        attachmentId: 'attachment-recovered',
        executionVerdict: 'live' as const
      }
    })
  }
}

function createCoordinator(
  registry: PtyOwnershipTransferDestinationRuntimeRegistry,
  source: ReturnType<typeof createRecoveredSource>,
  destinationCapabilities: PtyOwnershipBridgeCapabilities,
  options: Readonly<{ getReconnectGeneration?: () => number }> = {}
): PtyOwnershipTransferCoordinator {
  return new PtyOwnershipTransferCoordinator({
    source,
    destination: registry,
    identity,
    surfaceBinding,
    destinationCapabilities,
    ...options,
    createAttachmentId: () => 'attachment-recovered'
  })
}
