import { describe, expect, it, vi } from 'vitest'
import {
  PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES
} from '../../shared/pty-ownership-bridge-contract'
import {
  PtyOwnershipTransferOrchestrator,
  type RuntimeOwnedPtyOwnershipTransferReadOnlySource
} from './pty-ownership-transfer-orchestration'
import { createPtyOwnershipTransferDestinationRegistry } from './orca-runtime'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'relay-pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
} as const

function capabilities(liveTransfer: boolean, statusQuery = true) {
  return {
    protocolVersions: [1],
    maxReplayBytes: PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
    maxInputIds: PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
    inputDeduplication: true,
    rollback: true,
    liveTransfer,
    destinationOutput: liveTransfer,
    destinationControl: liveTransfer,
    authoritativeExit: liveTransfer,
    postCommitReplay: liveTransfer,
    statusQuery
  }
}

function createOrchestrator(
  provider: object | undefined,
  hasDestinationAdapter = false,
  mutationEnabled = false,
  localProvider?: object,
  inspectPty: (
    ptyId: string
  ) => { connectionId: string | null; incarnationId: string | null } | null = () => ({
    connectionId: 'target-1',
    incarnationId: 'incarnation-1'
  }),
  localReadOnlySource?: RuntimeOwnedPtyOwnershipTransferReadOnlySource,
  callPairedRuntimeRpc?: (
    environmentId: string,
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<unknown>
) {
  return new PtyOwnershipTransferOrchestrator({
    runtimeId: 'runtime-1',
    getSshProvider: () => provider as never,
    getLocalProvider: () => (localProvider as never) ?? null,
    getLocalReadOnlySource: () => localReadOnlySource ?? null,
    callPairedRuntimeRpc,
    inspectPty,
    hasDestinationAdapter: () => hasDestinationAdapter,
    mutationEnabled: () => mutationEnabled
  })
}

const request = {
  connectionId: 'target-1',
  ptyId: 'ssh:target-1@@relay-pty-1',
  destinationRuntimeId: 'runtime-1'
} as const

describe('PtyOwnershipTransferOrchestrator', () => {
  it('reports status support without enabling live transfer', async () => {
    const status = vi.fn()
    const orchestrator = createOrchestrator({
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)),
      ownershipTransfer: { status }
    })

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'live-transfer-disabled',
      capabilities: { liveTransfer: false, statusQuery: true }
    })
    expect(status).not.toHaveBeenCalled()
  })

  it('does not enable transfer when the source advertises live support before destination wiring', async () => {
    const orchestrator = createOrchestrator({
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(true)),
      ownershipTransfer: { status: vi.fn() }
    })

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'destination-adapter-unavailable',
      capabilities: { liveTransfer: true }
    })
  })

  it('keeps production mutation disabled even when source and destination wiring are present', async () => {
    const orchestrator = createOrchestrator(
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(true)),
        ownershipTransfer: { status: vi.fn() }
      },
      true
    )

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'production-transfer-disabled'
    })
  })

  it('requires a separately advertised destination output route', async () => {
    const orchestrator = createOrchestrator({
      getOwnershipBridgeCapabilities: vi.fn(async () => ({
        ...capabilities(true),
        destinationOutput: false
      })),
      ownershipTransfer: { status: vi.fn() }
    })

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      blocker: 'destination-output-unsupported'
    })
  })

  it('requires attachment-fenced post-commit replay before enabling transfer', async () => {
    const orchestrator = createOrchestrator(
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => ({
          ...capabilities(true),
          postCommitReplay: false
        })),
        ownershipTransfer: { status: vi.fn() }
      },
      true,
      true
    )

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      blocker: 'post-commit-replay-unsupported'
    })
  })

  it('requires destination control and authoritative exit routes before enabling transfer', async () => {
    const base = capabilities(true)
    const controlMissing = createOrchestrator(
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => ({
          ...base,
          destinationControl: false
        })),
        ownershipTransfer: { status: vi.fn() }
      },
      true,
      true
    )
    await expect(controlMissing.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      blocker: 'destination-control-unsupported'
    })

    const exitMissing = createOrchestrator(
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => ({
          ...base,
          authoritativeExit: false
        })),
        ownershipTransfer: { status: vi.fn() }
      },
      true,
      true
    )
    await expect(exitMissing.preflight(request)).resolves.toMatchObject({
      transferSupported: false,
      blocker: 'authoritative-exit-unsupported'
    })
  })

  it('reports transfer capability only when the explicit mutation gate is enabled', async () => {
    const orchestrator = createOrchestrator(
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(true)),
        ownershipTransfer: { status: vi.fn() }
      },
      true,
      true
    )

    await expect(orchestrator.preflight(request)).resolves.toMatchObject({
      transferSupported: true,
      statusQuerySupported: true,
      blocker: null
    })
  })

  it('refuses non-SSH and mismatched destination topologies before probing a provider', async () => {
    const getOwnershipBridgeCapabilities = vi.fn()
    const orchestrator = createOrchestrator({ getOwnershipBridgeCapabilities })

    await expect(orchestrator.preflight({ ...request, ptyId: 'local-pty' })).resolves.toMatchObject(
      { blocker: 'source-not-direct-ssh' }
    )
    await expect(
      orchestrator.preflight({ ...request, destinationRuntimeId: 'runtime-2' })
    ).resolves.toMatchObject({ blocker: 'destination-runtime-mismatch' })
    expect(getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
  })

  it('probes a runtime-owned local PTY without enabling mutation', async () => {
    const getOwnershipBridgeCapabilities = vi.fn(async () => capabilities(false))
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      { getOwnershipBridgeCapabilities },
      () => ({ connectionId: null, incarnationId: 'incarnation-local' })
    )

    await expect(
      orchestrator.preflight({
        connectionId: null,
        ptyId: 'local-pty-1',
        destinationRuntimeId: 'runtime-2'
      })
    ).resolves.toMatchObject({
      topology: 'runtime-owned',
      transferSupported: false,
      statusQuerySupported: false,
      blocker: 'live-transfer-disabled',
      capabilities: { liveTransfer: false }
    })
    expect(getOwnershipBridgeCapabilities).toHaveBeenCalledOnce()
  })

  it('requires a host-local probe for a paired-runtime PTY reference', async () => {
    const getOwnershipBridgeCapabilities = vi.fn()
    const orchestrator = createOrchestrator(undefined, false, false, {
      getOwnershipBridgeCapabilities
    })

    await expect(
      orchestrator.preflight({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({
      topology: 'paired-runtime-reference',
      transferSupported: false,
      blocker: 'source-runtime-probe-required'
    })
    expect(getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
  })

  it('routes paired-runtime preflight through the owner runtime when a bridge is installed', async () => {
    const callPairedRuntimeRpc = vi.fn(async () => ({
      topology: 'runtime-owned',
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'live-transfer-disabled',
      capabilities: { ...capabilities(false), statusQuery: true }
    }))
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      undefined,
      () => null,
      undefined,
      callPairedRuntimeRpc
    )

    await expect(
      orchestrator.preflight({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({
      topology: 'paired-runtime-reference',
      statusQuerySupported: true,
      blocker: 'live-transfer-disabled'
    })
    expect(callPairedRuntimeRpc).toHaveBeenCalledWith(
      'paired-env',
      'pty.ownershipTransfer.preflightSource',
      { ptyId: 'terminal-1', destinationRuntimeId: 'runtime-1' },
      undefined
    )
  })

  it('treats an older paired runtime as unavailable without masking transport failures', async () => {
    const missing = createOrchestrator(
      undefined,
      false,
      false,
      undefined,
      () => null,
      undefined,
      vi.fn(async () => {
        throw { code: 'method_not_found', message: 'Unknown method' }
      })
    )
    await expect(
      missing.preflight({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({ blocker: 'source-capabilities-unavailable' })

    const offline = createOrchestrator(
      undefined,
      false,
      false,
      undefined,
      () => null,
      undefined,
      vi.fn(async () => {
        throw new Error('paired transport unavailable')
      })
    )
    await expect(
      offline.preflight({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1'
      })
    ).rejects.toThrow('paired transport unavailable')
  })

  it('refuses a runtime-owned transfer back into the same runtime', async () => {
    const getOwnershipBridgeCapabilities = vi.fn()
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      { getOwnershipBridgeCapabilities },
      () => ({ connectionId: null, incarnationId: 'incarnation-local' })
    )

    await expect(
      orchestrator.preflight({
        connectionId: null,
        ptyId: 'local-pty-1',
        destinationRuntimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({
      topology: 'runtime-owned',
      transferSupported: false,
      blocker: 'destination-runtime-not-distinct'
    })
    expect(getOwnershipBridgeCapabilities).not.toHaveBeenCalled()
  })

  it('issues only the additive status RPC when statusQuery is advertised', async () => {
    const status = vi.fn(async (value) => ({
      ...value,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 4,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 0,
      acceptedInputIds: 0
    }))
    const orchestrator = createOrchestrator({
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)),
      ownershipTransfer: { status }
    })

    await expect(orchestrator.status({ ...request, identity })).resolves.toMatchObject({
      phase: 'prepared',
      bridgeId: 'bridge-1'
    })
    expect(status).toHaveBeenCalledWith({ ...identity, version: 1 }, undefined)
  })

  it('routes paired-runtime status through the owner runtime with exact identity checks', async () => {
    const pairedIdentity = {
      ...identity,
      terminalId: 'terminal-1',
      destinationRuntimeId: 'runtime-1'
    }
    const callPairedRuntimeRpc = vi.fn(async (environmentId: string, method: string) => {
      if (method.endsWith('preflightSource')) {
        return {
          topology: 'runtime-owned',
          transferSupported: false,
          statusQuerySupported: true,
          blocker: 'live-transfer-disabled',
          capabilities: { ...capabilities(false), statusQuery: true }
        }
      }
      expect(environmentId).toBe('paired-env')
      return {
        ...pairedIdentity,
        version: 1,
        phase: 'prepared',
        sourceOutputEndSeq: 2,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 0,
        acceptedInputIds: 0
      }
    })
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      undefined,
      () => null,
      undefined,
      callPairedRuntimeRpc
    )

    await expect(
      orchestrator.status({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1',
        identity: pairedIdentity
      })
    ).resolves.toMatchObject({ phase: 'prepared', terminalId: 'terminal-1' })
    expect(callPairedRuntimeRpc).toHaveBeenCalledWith(
      'paired-env',
      'pty.ownershipTransfer.statusSource',
      expect.objectContaining({ ptyId: 'terminal-1', identity: pairedIdentity }),
      undefined
    )

    await expect(
      orchestrator.status({
        connectionId: null,
        ptyId: 'remote:paired-env@@terminal-1',
        destinationRuntimeId: 'runtime-1',
        identity: { ...pairedIdentity, terminalId: 'other-terminal' }
      })
    ).rejects.toThrow('pty_ownership_transfer_status_identity_mismatch')
  })

  it('routes a read-only status probe to the runtime-owned local provider', async () => {
    const localIdentity = {
      ...identity,
      terminalId: 'local-pty-1',
      destinationRuntimeId: 'runtime-destination'
    }
    const getOwnershipTransferStatus = vi.fn(async (value) => ({
      ...value,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 3,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 0,
      acceptedInputIds: 0
    }))
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)),
        getOwnershipTransferStatus
      },
      () => ({ connectionId: null, incarnationId: localIdentity.incarnationId })
    )
    const localRequest = {
      connectionId: null,
      ptyId: localIdentity.terminalId,
      destinationRuntimeId: localIdentity.destinationRuntimeId
    } as const

    await expect(
      orchestrator.status({ ...localRequest, identity: localIdentity, timeoutMs: 2_000 })
    ).resolves.toMatchObject({ phase: 'prepared', bridgeId: localIdentity.bridgeId })
    expect(getOwnershipTransferStatus).toHaveBeenCalledWith(
      { ...localIdentity, version: 1 },
      { timeoutMs: 2_000 }
    )
    await expect(orchestrator.preflight(localRequest)).resolves.toMatchObject({
      topology: 'runtime-owned',
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'live-transfer-disabled'
    })
  })

  it('routes local status through the reconciled read-only source without exposing mutation', async () => {
    const localIdentity = {
      ...identity,
      terminalId: 'local-pty-1',
      destinationRuntimeId: 'runtime-destination'
    }
    const localProvider = {}
    const reconcileProvider = vi.fn(async () => ({ state: 'current' }))
    const getOwnershipTransferStatus = vi.fn((value) => ({
      ...value,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 3,
      replayStartSeq: 1,
      acceptedSourceEndSeq: 0,
      acceptedInputIds: 0
    }))
    const readOnlySource: RuntimeOwnedPtyOwnershipTransferReadOnlySource = {
      reconcileProvider,
      getOwnershipBridgeCapabilities: () => capabilities(false),
      getOwnershipTransferStatus
    }
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      localProvider,
      () => ({ connectionId: null, incarnationId: localIdentity.incarnationId }),
      readOnlySource
    )
    const localRequest = {
      connectionId: null,
      ptyId: localIdentity.terminalId,
      destinationRuntimeId: localIdentity.destinationRuntimeId
    } as const

    await expect(orchestrator.preflight(localRequest)).resolves.toMatchObject({
      topology: 'runtime-owned',
      transferSupported: false,
      statusQuerySupported: true,
      blocker: 'live-transfer-disabled'
    })
    await expect(
      orchestrator.status({ ...localRequest, identity: localIdentity })
    ).resolves.toMatchObject({ bridgeId: localIdentity.bridgeId, phase: 'prepared' })
    expect(reconcileProvider).toHaveBeenCalledWith(localProvider)
    expect(getOwnershipTransferStatus).toHaveBeenCalledWith(
      { ...localIdentity, version: 1 },
      undefined
    )
    expect(localProvider).not.toHaveProperty('getOwnershipTransferStatus')
  })

  it('refuses runtime-owned status when the advertised reader or exact identity is absent', async () => {
    const status = vi.fn()
    const localIdentity = {
      ...identity,
      terminalId: 'local-pty-1',
      destinationRuntimeId: 'runtime-destination'
    }
    const inspectLocal = () => ({ connectionId: null, incarnationId: localIdentity.incarnationId })
    const withoutReader = createOrchestrator(
      undefined,
      false,
      false,
      { getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)) },
      inspectLocal
    )
    const withReader = createOrchestrator(
      undefined,
      false,
      false,
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)),
        getOwnershipTransferStatus: status
      },
      inspectLocal
    )
    const localRequest = {
      connectionId: null,
      ptyId: localIdentity.terminalId,
      destinationRuntimeId: localIdentity.destinationRuntimeId,
      identity: localIdentity
    } as const

    await expect(withoutReader.status(localRequest)).rejects.toThrow(
      'pty_ownership_transfer_status_unsupported'
    )
    await expect(
      withReader.status({
        ...localRequest,
        identity: { ...localIdentity, terminalId: 'another-pty' }
      })
    ).rejects.toThrow('pty_ownership_transfer_status_identity_mismatch')
    expect(status).not.toHaveBeenCalled()
  })

  it('rejects a runtime-owned status response for another bridge identity', async () => {
    const localIdentity = {
      ...identity,
      terminalId: 'local-pty-1',
      destinationRuntimeId: 'runtime-destination'
    }
    const orchestrator = createOrchestrator(
      undefined,
      false,
      false,
      {
        getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(false)),
        getOwnershipTransferStatus: vi.fn(async (value) => ({
          ...value,
          bridgeId: 'another-bridge',
          phase: 'prepared' as const,
          sourceOutputEndSeq: 3,
          replayStartSeq: 1,
          acceptedSourceEndSeq: 0,
          acceptedInputIds: 0
        }))
      },
      () => ({ connectionId: null, incarnationId: localIdentity.incarnationId })
    )

    await expect(
      orchestrator.status({
        connectionId: null,
        ptyId: localIdentity.terminalId,
        destinationRuntimeId: localIdentity.destinationRuntimeId,
        identity: localIdentity
      })
    ).rejects.toThrow('pty_ownership_transfer_response_identity_mismatch')
  })

  it('does not send status to an unadvertised or identity-mismatched peer', async () => {
    const status = vi.fn()
    const orchestrator = createOrchestrator({
      getOwnershipBridgeCapabilities: vi.fn(async () => capabilities(true, false)),
      ownershipTransfer: { status }
    })

    await expect(orchestrator.status({ ...request, identity })).rejects.toThrow(
      'pty_ownership_transfer_status_unsupported'
    )
    await expect(
      orchestrator.status({
        ...request,
        identity: { ...identity, terminalId: 'another-pty' }
      })
    ).rejects.toThrow('pty_ownership_transfer_status_identity_mismatch')
    expect(status).not.toHaveBeenCalled()
  })
})

describe('destination registry construction gate', () => {
  const store = {
    getProfileStorageDirectory: () => '/tmp/orca-profile',
    inspectPtyOwnershipTransferSurface: vi.fn(),
    publishPtyOwnershipTransferSurface: vi.fn()
  }

  it('returns null until an acknowledged post-commit sink is supplied', () => {
    expect(
      createPtyOwnershipTransferDestinationRegistry(store as never, 'runtime-1', undefined)
    ).toBeNull()
  })

  it('constructs the durable destination registry with complete opt-in seams', () => {
    const sink = vi.fn()
    const acknowledged = vi.fn(() => ({
      identity,
      throughSeq: 1
    }))
    expect(
      createPtyOwnershipTransferDestinationRegistry(store as never, 'runtime-1', sink, acknowledged)
    ).not.toBeNull()
  })

  it('rejects a legacy void sink that cannot prove durable destination acceptance', () => {
    expect(
      createPtyOwnershipTransferDestinationRegistry(store as never, 'runtime-1', vi.fn())
    ).toBeNull()
  })
})
