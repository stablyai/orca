import { describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipTransferSourceGrant } from '../../../../shared/pty-ownership-transfer-source-grant'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from './pty-ownership-transfer'

const surfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:workspace-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'local-pty-1'
} as const
const request = {
  version: 1,
  terminalId: 'local-pty-1',
  destinationRuntimeId: 'runtime-destination',
  surfaceBinding
} as const
const grant: PtyOwnershipTransferSourceGrant = {
  version: 1,
  identity: {
    bridgeId: 'runtime-grant-1',
    terminalId: request.terminalId,
    incarnationId: 'incarnation-1',
    ownerLease: 'lease-1',
    sourceOwnerGeneration: 1,
    destinationRuntimeId: request.destinationRuntimeId
  },
  surfaceBinding
}

function grantMethod() {
  const candidate = eraseRpcMethods(PTY_OWNERSHIP_TRANSFER_METHODS).find(
    (entry) => entry.name === 'pty.ownershipTransfer.grantSource'
  )
  if (!candidate || isStreamingMethod(candidate)) {
    throw new Error('missing ownership-transfer grant method')
  }
  return candidate
}

function context(runtime: OrcaRuntimeService, overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    runtime,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-device-1',
    connectionId: 'socket-1',
    transportGeneration: 7,
    ...overrides
  }
}

describe('PTY ownership-transfer source grant RPC', () => {
  it('registers the additive paired-runtime grant method once', () => {
    expect(
      ALL_RPC_METHODS.filter((candidate) => candidate.name === 'pty.ownershipTransfer.grantSource')
    ).toHaveLength(1)
  })

  it('routes a parsed request with the authenticated device and transport generation', async () => {
    const issuePairedRuntimePtyOwnershipTransferSourceGrant = vi.fn(() => grant)
    const runtime = {
      issuePairedRuntimePtyOwnershipTransferSourceGrant
    } as unknown as OrcaRuntimeService
    const rpc = grantMethod()

    expect(rpc.handler(rpc.params?.parse(request), context(runtime))).toEqual(grant)
    expect(issuePairedRuntimePtyOwnershipTransferSourceGrant).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        clientId: expect.any(Number),
        pairedDeviceId: 'paired-device-1',
        transportGeneration: 7,
        isStale: expect.any(Function)
      })
    )
  })

  it.each([
    ['mobile caller', { clientKind: 'mobile' }],
    ['unpaired runtime', { pairedDeviceId: undefined }],
    ['socket-less runtime', { connectionId: undefined }]
  ] as const)('rejects a %s before grant issuance', async (_label, overrides) => {
    const issuePairedRuntimePtyOwnershipTransferSourceGrant = vi.fn(() => grant)
    const runtime = {
      issuePairedRuntimePtyOwnershipTransferSourceGrant
    } as unknown as OrcaRuntimeService
    const rpc = grantMethod()

    await expect(
      Promise.resolve().then(() =>
        rpc.handler(rpc.params?.parse(request), context(runtime, overrides))
      )
    ).rejects.toThrow('pty_ownership_transfer_runtime_client_required')
    expect(issuePairedRuntimePtyOwnershipTransferSourceGrant).not.toHaveBeenCalled()
  })

  it('rejects an invalid surface before grant issuance', async () => {
    const issuePairedRuntimePtyOwnershipTransferSourceGrant = vi.fn(() => grant)
    const runtime = {
      issuePairedRuntimePtyOwnershipTransferSourceGrant
    } as unknown as OrcaRuntimeService
    const rpc = grantMethod()

    await expect(
      Promise.resolve().then(() =>
        rpc.handler(
          rpc.params?.parse({
            ...request,
            surfaceBinding: { ...surfaceBinding, executionHostId: 'ssh:other-host' }
          }),
          context(runtime)
        )
      )
    ).rejects.toThrow('pty_ownership_transfer_surface_binding_invalid')
    expect(issuePairedRuntimePtyOwnershipTransferSourceGrant).not.toHaveBeenCalled()
  })
})
