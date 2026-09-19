import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { PtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-journal'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => '/tmp/orca-runtime-transfer-execute' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const connectionId = 'target-1'
const terminalId = 'relay-pty-1'
const ptyId = toAppSshPtyId(connectionId, terminalId)
const incarnationId = 'incarnation-1'
const worktreeId = 'repo-1::/srv/repo'
const tabId = 'tab-1'
const leafId = '11111111-1111-4111-8111-111111111111'

const sourceIdentity = Object.freeze({
  terminalId,
  incarnationId,
  ownerLease: 'host-owner-lease',
  sourceOwnerGeneration: 7
})
const transferCapabilities = Object.freeze({
  protocolVersions: [1],
  maxReplayBytes: 1024,
  maxInputIds: 32,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true
})

function createRuntime(source: typeof sourceIdentity | null = sourceIdentity) {
  const getOwnershipTransferSourceIdentity = vi.fn(() => source)
  const installPublishedOwnershipTransferRoute = vi.fn()
  const provider = {
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity,
    installPublishedOwnershipTransferRoute
  }
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    getSshProvider: () => provider as never
  })
  runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
  const preflight = vi.spyOn(runtime, 'preflightPtyOwnershipTransfer')
  const createCoordinator = vi.spyOn(runtime, 'createPtyOwnershipTransferCoordinator')
  return {
    createCoordinator,
    getOwnershipTransferSourceIdentity,
    installPublishedOwnershipTransferRoute,
    preflight,
    runtime
  }
}

function request(runtime: OrcaRuntimeService, identity?: PtyOwnershipTransferIdentity) {
  return {
    connectionId,
    ptyId,
    destinationRuntimeId: runtime.getRuntimeId(),
    ...(identity ? { identity } : {}),
    surfaceBinding: {
      executionHostId: toSshExecutionHostId(connectionId),
      workspaceKey: worktreeWorkspaceKey(worktreeId),
      tabId,
      leafId,
      ptyId
    }
  }
}

function legacyIdentity(
  runtime: OrcaRuntimeService,
  overrides: Partial<PtyOwnershipTransferIdentity> = {}
): PtyOwnershipTransferIdentity {
  return {
    bridgeId: 'caller-bridge',
    terminalId,
    incarnationId,
    ownerLease: sourceIdentity.ownerLease,
    sourceOwnerGeneration: sourceIdentity.sourceOwnerGeneration,
    destinationRuntimeId: runtime.getRuntimeId(),
    ...overrides
  }
}

describe('OrcaRuntimeService ownership-transfer execute authority', () => {
  it.each([
    ['owner lease', { ownerLease: 'caller-lease' }],
    ['owner generation', { sourceOwnerGeneration: 8 }],
    ['incarnation', { incarnationId: 'caller-incarnation' }]
  ] as const)('rejects mismatched caller-supplied %s before preflight', async (_name, mismatch) => {
    const { createCoordinator, preflight, runtime } = createRuntime()

    await expect(
      runtime.transferPtyOwnership(request(runtime, legacyIdentity(runtime, mismatch)))
    ).rejects.toThrow('pty_ownership_transfer_execute_identity_mismatch')

    expect(preflight).not.toHaveBeenCalled()
    expect(createCoordinator).not.toHaveBeenCalled()
  })

  it('fails closed when the provider cannot prove source authority', async () => {
    const { createCoordinator, preflight, runtime } = createRuntime(null)

    await expect(runtime.transferPtyOwnership(request(runtime))).rejects.toThrow(
      'pty_ownership_transfer_source_authority_unavailable'
    )

    expect(preflight).not.toHaveBeenCalled()
    expect(createCoordinator).not.toHaveBeenCalled()
  })

  it('proves the published control route before starting an irreversible transfer', async () => {
    const provider = {
      providerGeneration: 9,
      getOwnershipTransferSourceIdentity: vi.fn(() => sourceIdentity)
    }
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      getSshProvider: () => provider as never
    })
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    const preflight = vi.spyOn(runtime, 'preflightPtyOwnershipTransfer')
    const createCoordinator = vi.spyOn(runtime, 'createPtyOwnershipTransferCoordinator')

    await expect(runtime.transferPtyOwnership(request(runtime))).rejects.toThrow(
      'pty_ownership_transfer_published_route_unavailable'
    )

    expect(preflight).not.toHaveBeenCalled()
    expect(createCoordinator).not.toHaveBeenCalled()
  })

  it('uses host-derived authority and mints the bridge identity', async () => {
    const { createCoordinator, preflight, runtime } = createRuntime()
    preflight.mockResolvedValue({
      transferSupported: true,
      capabilities: transferCapabilities
    } as never)
    createCoordinator.mockImplementation((options) => {
      const identity = options.identity
      return {
        transfer: vi.fn(async () => ({
          identity,
          commitReceipt: {},
          publicationReceipt: {},
          destination: {
            snapshot: () => ({
              phase: 'published',
              attachmentId: 'attachment-1',
              executionVerdict: 'live'
            })
          }
        }))
      } as never
    })

    const result = await runtime.transferPtyOwnership(request(runtime))

    expect(result.identity).toMatchObject(sourceIdentity)
    expect(result.identity.bridgeId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(createCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining(sourceIdentity) })
    )
  })

  it('installs the exact provider-generation route only after publication', async () => {
    const installPublishedOwnershipTransferRoute = vi.fn()
    const provider = {
      providerGeneration: 11,
      getOwnershipTransferSourceIdentity: vi.fn(() => sourceIdentity),
      installPublishedOwnershipTransferRoute
    }
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      getSshProvider: () => provider as never
    })
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    vi.spyOn(runtime, 'preflightPtyOwnershipTransfer').mockResolvedValue({
      transferSupported: true,
      capabilities: transferCapabilities
    } as never)
    vi.spyOn(runtime, 'createPtyOwnershipTransferCoordinator').mockImplementation(
      (options) =>
        ({
          transfer: vi.fn(async () => ({
            identity: options.identity,
            commitReceipt: {},
            publicationReceipt: {},
            destination: {
              snapshot: () => ({
                phase: 'published',
                attachmentId: 'attachment-1',
                executionVerdict: 'live'
              })
            }
          }))
        }) as never
    )

    const result = await runtime.transferPtyOwnership(request(runtime))

    expect(installPublishedOwnershipTransferRoute).toHaveBeenCalledWith({
      ptyId,
      identity: result.identity,
      attachmentId: 'attachment-1',
      capabilities: transferCapabilities,
      providerGeneration: 11
    })
  })

  it('does not expose a published route after source authority rotates in flight', async () => {
    const installPublishedOwnershipTransferRoute = vi.fn()
    const getOwnershipTransferSourceIdentity = vi
      .fn()
      .mockReturnValueOnce(sourceIdentity)
      .mockReturnValue({ ...sourceIdentity, sourceOwnerGeneration: 8 })
    const provider = {
      providerGeneration: 11,
      getOwnershipTransferSourceIdentity,
      installPublishedOwnershipTransferRoute
    }
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      getSshProvider: () => provider as never
    })
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    vi.spyOn(runtime, 'preflightPtyOwnershipTransfer').mockResolvedValue({
      transferSupported: true,
      capabilities: transferCapabilities
    } as never)
    vi.spyOn(runtime, 'createPtyOwnershipTransferCoordinator').mockImplementation(
      (options) =>
        ({
          transfer: vi.fn(async () => ({
            identity: options.identity,
            commitReceipt: {},
            publicationReceipt: {},
            destination: {
              snapshot: () => ({
                phase: 'published',
                attachmentId: 'attachment-1',
                executionVerdict: 'live'
              })
            }
          }))
        }) as never
    )

    await expect(runtime.transferPtyOwnership(request(runtime))).rejects.toThrow(
      'pty_ownership_transfer_published_route_unavailable'
    )
    expect(installPublishedOwnershipTransferRoute).not.toHaveBeenCalled()
  })
})

describe('OrcaRuntimeService direct-SSH ownership-transfer canary caller', () => {
  it('does not inspect or mutate transfer state while the process gate is closed', async () => {
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      ptyOwnershipTransferMutationEnabled: () => false
    })
    const getDestination = vi.spyOn(runtime, 'getPtyOwnershipTransferDestinationRegistry')
    const transfer = vi.spyOn(runtime, 'transferPtyOwnership')

    await expect(runtime.transferCanaryDirectSshPtysForConnection(connectionId)).resolves.toEqual(
      []
    )

    expect(getDestination).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()
  })

  it('derives an exact tracked surface and invokes the host-authorized execute path', async () => {
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      ptyOwnershipTransferMutationEnabled: () => true
    })
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    vi.spyOn(runtime, 'getPtyOwnershipTransferDestinationRegistry').mockReturnValue({
      listRecoveryCandidates: () => []
    } as never)
    const result = { identity: {}, commitReceipt: {}, publicationReceipt: {} }
    const transfer = vi.spyOn(runtime, 'transferPtyOwnership').mockResolvedValue(result as never)

    await expect(
      runtime.transferCanaryDirectSshPtysForConnection(connectionId, { timeoutMs: 10_000 })
    ).resolves.toEqual([result])

    expect(transfer).toHaveBeenCalledWith(
      {
        connectionId,
        ptyId,
        destinationRuntimeId: runtime.getRuntimeId(),
        surfaceBinding: {
          executionHostId: toSshExecutionHostId(connectionId),
          workspaceKey: worktreeWorkspaceKey(worktreeId),
          tabId,
          leafId,
          ptyId
        },
        timeoutMs: 10_000
      },
      undefined
    )
  })

  it('leaves an exact durable source fenced for recovery instead of minting a duplicate bridge', async () => {
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      ptyOwnershipTransferMutationEnabled: () => true
    })
    runtime.registerPty(ptyId, worktreeId, connectionId, { tabId, leafId, incarnationId })
    vi.spyOn(runtime, 'getPtyOwnershipTransferDestinationRegistry').mockReturnValue({
      listRecoveryCandidates: () => [
        {
          journal: { terminalId, incarnationId },
          surfaceBinding: null
        }
      ]
    } as never)
    const transfer = vi.spyOn(runtime, 'transferPtyOwnership')

    await expect(runtime.transferCanaryDirectSshPtysForConnection(connectionId)).resolves.toEqual(
      []
    )

    expect(transfer).not.toHaveBeenCalled()
  })
})
