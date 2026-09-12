import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from '../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type {
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferReplayResult
} from '../../shared/pty-ownership-transfer-wire'
import { createStore, testState } from '../persistence-test-harness'
import type { PtyOwnershipTransferSource } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-coordinator'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const connectionId = 'ssh-recovery-target'
const terminalId = 'relay-pty-recovery'
const ptyId = `ssh:${connectionId}@@${terminalId}`
const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: `ssh:${connectionId}`,
  workspaceKey: 'folder:folder-recovery',
  tabId: 'tab-recovery',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId
}
const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-recovery-startup',
  terminalId,
  incarnationId: 'incarnation-recovery-startup',
  ownerLease: 'lease-recovery-startup',
  sourceOwnerGeneration: 4,
  destinationRuntimeId: 'runtime-recovery-startup'
}
const commitReceipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'commit-recovery-startup',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 0,
  committedAt: '2026-08-31T12:00:00.000Z'
}
const capabilities: PtyOwnershipBridgeCapabilities = {
  protocolVersions: [1],
  maxReplayBytes: 128 * 1024,
  maxInputIds: 4_096,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true,
  postCommitReplay: true,
  reconnectRekey: false
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-runtime-transfer-recovery-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

function preparePublishedDestination(
  store: ReturnType<typeof createStore>
): PtyOwnershipTransferPublicationReceipt {
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId,
    ptyOwnershipTransferMutationEnabled: () => false,
    publishPtyOwnershipTransferPostCommitOutput: () => {},
    publishPtyOwnershipTransferPostCommitOutputAcknowledged: (
      transferIdentity,
      _binding,
      frame
    ) => ({
      identity: transferIdentity,
      throughSeq: frame.seq
    })
  })
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()
  if (!registry) {
    throw new Error('destination_registry_unavailable')
  }
  const preparedResult: PtyOwnershipTransferPrepareResult = {
    ...identity,
    version: 1,
    phase: 'prepared',
    sourceOutputEndSeq: 0,
    replayStartSeq: 1,
    surfacePublication: { version: 1, surfaceBinding }
  }
  const prepared = registry.prepare(preparedResult)
  prepared.adapter.bindSurface(surfaceBinding)
  const replay: PtyOwnershipTransferReplayResult = {
    ...identity,
    version: 1,
    phase: 'prepared',
    frames: [],
    sourceOutputEndSeq: 0,
    replayStartSeq: 1
  }
  prepared.adapter.acceptReplay(replay)
  prepared.adapter.commit(commitReceipt)
  const published = prepared.adapter.publish()
  expect(published).toMatchObject({
    version: 1,
    bridgeId: identity.bridgeId,
    destinationRuntimeId: identity.destinationRuntimeId,
    commitReceipt
  })
  return published
}

function createSource(
  expectedPublicationReceipt: PtyOwnershipTransferPublicationReceipt
): PtyOwnershipTransferSource {
  return {
    prepare: vi.fn(),
    replay: vi.fn(async (request) => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      frames: [],
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      attachmentId: request.attachmentId
    })),
    commit: vi.fn(),
    publish: vi.fn(async (request) => ({
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
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 0,
      acceptedInputIds: 0,
      commitReceipt,
      publicationReceipt: expectedPublicationReceipt
    })),
    attachDestination: vi.fn(async (request) => ({
      ...identity,
      version: 1 as const,
      phase: 'published' as const,
      attachmentId: request.attachmentId,
      executionVerdict: 'live' as const
    }))
  }
}

describe('OrcaRuntimeService direct-SSH ownership recovery', () => {
  it('reattaches only an exact durable candidate after the provider returns', async () => {
    const store = createStore()
    const expectedPublicationReceipt = preparePublishedDestination(store)
    const source = createSource(expectedPublicationReceipt)
    const installRoute = vi.fn()
    const provider = {
      providerGeneration: 9,
      ownershipTransfer: source,
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities),
      getOwnershipTransferSourceIdentity: vi.fn(() => ({
        terminalId,
        incarnationId: identity.incarnationId,
        ownerLease: identity.ownerLease,
        sourceOwnerGeneration: identity.sourceOwnerGeneration
      })),
      installPublishedOwnershipTransferRoute: installRoute
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      runtimeId: identity.destinationRuntimeId,
      getSshProvider: () => provider as never,
      ptyOwnershipTransferMutationEnabled: () => true,
      publishPtyOwnershipTransferPostCommitOutput: () => {},
      publishPtyOwnershipTransferPostCommitOutputAcknowledged: (
        transferIdentity,
        _binding,
        frame
      ) => ({
        identity: transferIdentity,
        throughSeq: frame.seq
      })
    })

    const recovered =
      await runtime.recoverPtyOwnershipTransferDestinationsForConnection(connectionId)

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      phase: 'published',
      executionVerdict: 'live',
      attachmentId: expect.any(String)
    })
    expect(source.status).toHaveBeenCalledOnce()
    expect(source.attachDestination).toHaveBeenCalledOnce()
    expect(installRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId,
        identity,
        capabilities,
        providerGeneration: 9
      })
    )
  })

  it('keeps startup recovery inert while the mutation gate is closed', async () => {
    const store = createStore()
    const expectedPublicationReceipt = preparePublishedDestination(store)
    const source = createSource(expectedPublicationReceipt)
    const installRoute = vi.fn()
    const provider = {
      providerGeneration: 9,
      ownershipTransfer: source,
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities),
      getOwnershipTransferSourceIdentity: vi.fn(() => ({
        terminalId,
        incarnationId: identity.incarnationId,
        ownerLease: identity.ownerLease,
        sourceOwnerGeneration: identity.sourceOwnerGeneration
      })),
      installPublishedOwnershipTransferRoute: installRoute
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      runtimeId: identity.destinationRuntimeId,
      getSshProvider: () => provider as never,
      publishPtyOwnershipTransferPostCommitOutput: () => {},
      publishPtyOwnershipTransferPostCommitOutputAcknowledged: (
        transferIdentity,
        _binding,
        frame
      ) => ({
        identity: transferIdentity,
        throughSeq: frame.seq
      })
    })

    await expect(
      runtime.recoverPtyOwnershipTransferDestinationsForConnection(connectionId)
    ).resolves.toEqual([])
    expect(source.status).not.toHaveBeenCalled()
    expect(source.attachDestination).not.toHaveBeenCalled()
    expect(installRoute).not.toHaveBeenCalled()
  })

  it('skips candidates when the authenticated source identity does not match', async () => {
    const store = createStore()
    const expectedPublicationReceipt = preparePublishedDestination(store)
    const source = createSource(expectedPublicationReceipt)
    const provider = {
      providerGeneration: 9,
      ownershipTransfer: source,
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities),
      getOwnershipTransferSourceIdentity: vi.fn(() => ({
        terminalId,
        incarnationId: 'different-incarnation',
        ownerLease: identity.ownerLease,
        sourceOwnerGeneration: identity.sourceOwnerGeneration
      })),
      installPublishedOwnershipTransferRoute: vi.fn()
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      runtimeId: identity.destinationRuntimeId,
      getSshProvider: () => provider as never,
      ptyOwnershipTransferMutationEnabled: () => true,
      publishPtyOwnershipTransferPostCommitOutput: () => {},
      publishPtyOwnershipTransferPostCommitOutputAcknowledged: (
        transferIdentity,
        _binding,
        frame
      ) => ({
        identity: transferIdentity,
        throughSeq: frame.seq
      })
    })

    await expect(
      runtime.recoverPtyOwnershipTransferDestinationsForConnection(connectionId)
    ).resolves.toEqual([])
    expect(source.status).not.toHaveBeenCalled()
    expect(source.attachDestination).not.toHaveBeenCalled()
  })

  it('does not attach a stale generation without reconnect rekey support', async () => {
    const store = createStore()
    const expectedPublicationReceipt = preparePublishedDestination(store)
    const source = createSource(expectedPublicationReceipt)
    const provider = {
      providerGeneration: 9,
      ownershipTransfer: source,
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities),
      getOwnershipTransferSourceIdentity: vi.fn(() => ({
        terminalId,
        incarnationId: identity.incarnationId,
        ownerLease: identity.ownerLease,
        sourceOwnerGeneration: identity.sourceOwnerGeneration + 1
      })),
      installPublishedOwnershipTransferRoute: vi.fn()
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      runtimeId: identity.destinationRuntimeId,
      getSshProvider: () => provider as never,
      ptyOwnershipTransferMutationEnabled: () => true,
      publishPtyOwnershipTransferPostCommitOutput: () => {},
      publishPtyOwnershipTransferPostCommitOutputAcknowledged: (
        transferIdentity,
        _binding,
        frame
      ) => ({
        identity: transferIdentity,
        throughSeq: frame.seq
      })
    })

    await expect(
      runtime.recoverPtyOwnershipTransferDestinationsForConnection(connectionId)
    ).resolves.toEqual([])
    expect(source.status).not.toHaveBeenCalled()
    expect(provider.getOwnershipBridgeCapabilities).toHaveBeenCalledOnce()
  })
})
