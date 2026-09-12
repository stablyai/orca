import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { eraseRpcMethods, isStreamingMethod, type RpcContext, type RpcRequest } from '../core'
import { ALL_RPC_METHODS } from './index'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from './pty-ownership-transfer'

function method() {
  return namedMethod('pty.ownershipTransfer.preflightSource')
}

function namedMethod(name: string) {
  const candidate = eraseRpcMethods(PTY_OWNERSHIP_TRANSFER_METHODS).find((entry) => entry.name === name)
  if (!candidate || isStreamingMethod(candidate)) {
    throw new Error(`missing ownership-transfer method: ${name}`)
  }
  return candidate
}

function streamingMethod(name: string) {
  const candidate = eraseRpcMethods(PTY_OWNERSHIP_TRANSFER_METHODS).find((entry) => entry.name === name)
  if (!candidate || !isStreamingMethod(candidate)) {
    throw new Error(`missing ownership-transfer streaming method: ${name}`)
  }
  return candidate
}

function context(overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    runtime: {
      preflightPtyOwnershipTransfer: vi.fn().mockResolvedValue({
        topology: 'runtime-owned',
        transferSupported: false,
        statusQuerySupported: false,
        blocker: 'live-transfer-disabled',
        capabilities: { liveTransfer: false }
      }),
      getPtyOwnershipTransferStatus: vi.fn().mockResolvedValue({
        version: 1,
        bridgeId: 'bridge-1',
        terminalId: 'terminal-1',
        incarnationId: 'incarnation-1',
        ownerLease: 'lease-1',
        sourceOwnerGeneration: 2,
        destinationRuntimeId: 'runtime-destination',
        phase: 'prepared',
        sourceOutputEndSeq: 4,
        replayStartSeq: 1,
        acceptedSourceEndSeq: 0,
        acceptedInputIds: 0
      })
    } as unknown as OrcaRuntimeService,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-desktop',
    connectionId: 'test-connection',
    ...overrides
  }
}

const prepareParams = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 2,
  destinationRuntimeId: 'runtime-destination',
  version: 1
} as const

function prepareResult() {
  return {
    ...prepareParams,
    phase: 'prepared' as const,
    sourceOutputEndSeq: 0,
    replayStartSeq: 1
  }
}

function pairedRequest(id: string): RpcRequest {
  return {
    id,
    authToken: 'paired-token',
    method: 'pty.ownershipTransfer.prepareSource',
    params: prepareParams
  }
}

describe('PTY ownership-transfer source preflight RPC', () => {
  it('registers additive read-only paired-runtime methods', () => {
    expect(
      ALL_RPC_METHODS.filter(
        (candidate) => candidate.name === 'pty.ownershipTransfer.preflightSource'
      )
    ).toHaveLength(1)
    expect(
      ALL_RPC_METHODS.filter((candidate) => candidate.name === 'pty.ownershipTransfer.statusSource')
    ).toHaveLength(1)
  })

  it('routes an authenticated status probe to the source runtime without mutation', async () => {
    const rpc = namedMethod('pty.ownershipTransfer.statusSource')
    const caller = context()
    const identity = {
      bridgeId: 'bridge-1',
      terminalId: 'terminal-1',
      incarnationId: 'incarnation-1',
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 2,
      destinationRuntimeId: 'runtime-destination'
    }

    await expect(
      rpc.handler(
        rpc.params?.parse({
          ptyId: identity.terminalId,
          destinationRuntimeId: identity.destinationRuntimeId,
          identity,
          timeoutMs: 2_000
        }),
        caller
      )
    ).resolves.toMatchObject({ phase: 'prepared', bridgeId: identity.bridgeId })
    expect(caller.runtime.getPtyOwnershipTransferStatus).toHaveBeenCalledWith({
      connectionId: null,
      ptyId: identity.terminalId,
      destinationRuntimeId: identity.destinationRuntimeId,
      identity,
      timeoutMs: 2_000
    })
    expect(caller.runtime.preflightPtyOwnershipTransfer).not.toHaveBeenCalled()
  })

  it.each([
    ['mobile', { clientKind: 'mobile', pairedDeviceId: 'phone-1' }],
    ['unpaired runtime', { clientKind: 'runtime', pairedDeviceId: undefined }],
    ['local caller', { clientKind: undefined, pairedDeviceId: undefined }]
  ] as const)('rejects a %s caller before reading transfer status', async (_label, overrides) => {
    const rpc = namedMethod('pty.ownershipTransfer.statusSource')
    const caller = context(overrides)

    await expect(
      Promise.resolve().then(() =>
        rpc.handler(
          rpc.params?.parse({
            ptyId: 'terminal-1',
            destinationRuntimeId: 'runtime-destination',
            identity: {
              bridgeId: 'bridge-1',
              terminalId: 'terminal-1',
              incarnationId: 'incarnation-1',
              ownerLease: 'lease-1',
              sourceOwnerGeneration: 2,
              destinationRuntimeId: 'runtime-destination'
            }
          }),
          caller
        )
      )
    ).rejects.toThrow('pty_ownership_transfer_runtime_client_required')
    expect(caller.runtime.getPtyOwnershipTransferStatus).not.toHaveBeenCalled()
  })

  it('probes the source runtime local provider without enabling mutation', async () => {
    const rpc = method()
    const caller = context()
    const params = { ptyId: 'terminal-1', destinationRuntimeId: 'runtime-destination' }

    await expect(rpc.handler(rpc.params?.parse(params), caller)).resolves.toMatchObject({
      topology: 'runtime-owned',
      transferSupported: false,
      blocker: 'live-transfer-disabled'
    })
    expect(caller.runtime.preflightPtyOwnershipTransfer).toHaveBeenCalledWith({
      connectionId: null,
      ...params
    })
  })

  it.each([
    ['mobile', { clientKind: 'mobile', pairedDeviceId: 'phone-1' }],
    ['unpaired runtime', { clientKind: 'runtime', pairedDeviceId: undefined }],
    ['local caller', { clientKind: undefined, pairedDeviceId: undefined }]
  ] as const)('rejects a %s caller before probing the source', async (_label, overrides) => {
    const rpc = method()
    const caller = context(overrides)

    await expect(
      Promise.resolve().then(() =>
        rpc.handler(
          rpc.params?.parse({
            ptyId: 'terminal-1',
            destinationRuntimeId: 'runtime-destination'
          }),
          caller
        )
      )
    ).rejects.toThrow('pty_ownership_transfer_runtime_client_required')
    expect(caller.runtime.preflightPtyOwnershipTransfer).not.toHaveBeenCalled()
  })

  it('propagates the authenticated socket generation into unary mutation bindings', async () => {
    const bindings: { clientId: number; transportGeneration?: number }[] = []
    const source = {
      prepare: vi.fn((_request: unknown, binding: (typeof bindings)[number]) => {
        bindings.push(binding)
        return prepareResult()
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [namedMethod('pty.ownershipTransfer.prepareSource')]
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(pairedRequest('request-a'), (reply) => replies.push(reply), {
      clientKind: 'runtime',
      pairedDeviceId: 'paired-device',
      clientId: 'request-supplied-token',
      connectionId: 'socket-a',
      transportGeneration: 17
    })

    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: true, result: prepareResult() })
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ transportGeneration: 17 })
    // The authenticated socket identity is authoritative; request/device tokens are not.
    expect(bindings[0]!.clientId).not.toBe(0)
  })

  it('isolates simultaneous sockets that share one paired device credential', async () => {
    const bindings: { clientId: number; transportGeneration?: number }[] = []
    const source = {
      prepare: vi.fn((_request: unknown, binding: (typeof bindings)[number]) => {
        bindings.push(binding)
        return prepareResult()
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [namedMethod('pty.ownershipTransfer.prepareSource')]
    })

    await Promise.all([
      dispatcher.dispatchStreaming(pairedRequest('request-a'), () => {}, {
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        clientId: 'spoofed-a',
        connectionId: 'socket-a',
        transportGeneration: 21
      }),
      dispatcher.dispatchStreaming(pairedRequest('request-b'), () => {}, {
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        clientId: 'spoofed-b',
        connectionId: 'socket-b',
        transportGeneration: 22
      })
    ])

    expect(bindings).toHaveLength(2)
    expect(bindings[0]!.clientId).not.toBe(bindings[1]!.clientId)
    expect(new Set(bindings.map((binding) => binding.transportGeneration))).toEqual(
      new Set([21, 22])
    )
  })

  it('rejects a unary mutation whose authenticated socket is already closed', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = {
      prepare: vi.fn((_request: unknown, binding: { isStale: () => boolean }) => {
        if (binding.isStale()) {
          throw new Error('pty_ownership_transfer_runtime_request_stale')
        }
        return prepareResult()
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [namedMethod('pty.ownershipTransfer.prepareSource')]
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      pairedRequest('request-closed'),
      (reply) => replies.push(reply),
      {
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        connectionId: 'socket-closed',
        transportGeneration: 23,
        signal: controller.signal
      }
    )

    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { message: 'pty_ownership_transfer_runtime_request_stale' }
    })
    expect(source.prepare).toHaveBeenCalledOnce()
  })

  it('rejects a paired mutation without an authenticated socket identity', async () => {
    const source = {
      prepare: vi.fn(() => prepareResult())
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [namedMethod('pty.ownershipTransfer.prepareSource')]
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      pairedRequest('request-without-socket'),
      (reply) => replies.push(reply),
      {
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        transportGeneration: 24
      }
    )

    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { message: 'pty_ownership_transfer_runtime_client_required' }
    })
    expect(source.prepare).not.toHaveBeenCalled()
  })

  it('emits a readiness frame and tears down source listeners on disconnect', async () => {
    const controller = new AbortController()
    const outputListeners = new Set<(event: unknown) => void>()
    const exitListeners = new Set<(event: unknown) => void>()
    const source = {
      getCapabilities: vi.fn(() => ({
        liveTransfer: true,
        destinationOutput: true,
        authoritativeExit: true
      })),
      assertStreamAuthorized: vi.fn(),
      snapshot: vi.fn(() => ({ identity: prepareParams })),
      onDestinationOutput: vi.fn((listener: (event: unknown) => void) => {
        outputListeners.add(listener)
        return () => outputListeners.delete(listener)
      }),
      onDestinationExit: vi.fn((listener: (event: unknown) => void) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const rpc = streamingMethod('pty.ownershipTransfer.streamSource')
    const emitted: unknown[] = []
    const pending = rpc.handler(
      { ...prepareParams, attachmentId: 'attachment-1' },
      {
        runtime,
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        connectionId: 'socket-1',
        signal: controller.signal
      },
      (value) => emitted.push(value)
    )

    await Promise.resolve()
    expect(emitted[0]).toMatchObject({ kind: 'ready', attachmentId: 'attachment-1' })
    expect(outputListeners).toHaveLength(1)
    expect(exitListeners).toHaveLength(1)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(outputListeners).toHaveLength(0)
    expect(exitListeners).toHaveLength(0)
    expect(source.assertStreamAuthorized).toHaveBeenCalledOnce()
  })

  it('negotiates bounded output credit and flushes queued frames after a cumulative ACK', async () => {
    const controller = new AbortController()
    const outputListeners = new Set<(event: unknown) => void>()
    const exitListeners = new Set<(event: unknown) => void>()
    let acknowledgeOutput: ((throughSeq: number) => void) | undefined
    const source = {
      getCapabilities: vi.fn(() => ({
        liveTransfer: true,
        destinationOutput: true,
        authoritativeExit: true
      })),
      assertStreamAuthorized: vi.fn(),
      snapshot: vi.fn(() => ({ identity: prepareParams })),
      onDestinationOutputAcknowledgement: vi.fn(
        (
          _identity: unknown,
          _attachmentId: string,
          _binding: unknown,
          callback: (throughSeq: number) => void
        ) => {
          acknowledgeOutput = callback
          return () => {
            acknowledgeOutput = undefined
          }
        }
      ),
      onDestinationOutput: vi.fn((listener: (event: unknown) => void) => {
        outputListeners.add(listener)
        return () => outputListeners.delete(listener)
      }),
      onDestinationExit: vi.fn((listener: (event: unknown) => void) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const rpc = streamingMethod('pty.ownershipTransfer.streamSource')
    const emitted: unknown[] = []
    const pending = rpc.handler(
      {
        ...prepareParams,
        attachmentId: 'attachment-1',
        outputCredit: { version: 1, windowBytes: 4, windowFrames: 2 }
      },
      {
        runtime,
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        connectionId: 'socket-1',
        transportGeneration: 1,
        signal: controller.signal
      },
      (value) => emitted.push(value)
    )

    await Promise.resolve()
    expect(emitted[0]).toMatchObject({
      kind: 'ready',
      attachmentId: 'attachment-1',
      outputCredit: { version: 1, windowBytes: 4, windowFrames: 2 }
    })
    const output = {
      identity: prepareParams,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'abc' }
    }
    for (const listener of outputListeners) {
      listener(output)
    }
    expect(emitted).toHaveLength(2)
    for (const listener of outputListeners) {
      listener({ ...output, frame: { seq: 2, data: 'de' } })
    }
    expect(emitted).toHaveLength(2)
    acknowledgeOutput?.(1)
    expect(emitted).toHaveLength(3)
    expect(emitted[2]).toMatchObject({ kind: 'output', frame: { seq: 2, data: 'de' } })
    for (const listener of outputListeners) {
      listener({ ...output, frame: { seq: 3, data: 'xyz' } })
      listener({ ...output, frame: { seq: 4, data: 'q' } })
      listener({ ...output, frame: { seq: 5, data: 'overflow' } })
    }
    expect(emitted[3]).toEqual({
      kind: 'loss',
      code: 'pty_ownership_transfer_output_credit_queue_overflow'
    })
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(outputListeners).toHaveLength(0)
    expect(exitListeners).toHaveLength(0)
  })

  it('registers and routes the paired output acknowledgement source RPC', async () => {
    const acknowledgement = {
      version: 1,
      identity: prepareParams,
      attachmentId: 'attachment-1',
      throughSeq: 3
    }
    const source = {
      acknowledgeDestinationOutput: vi.fn(() => acknowledgement)
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const rpc = namedMethod('pty.ownershipTransfer.acknowledgeOutputSource')
    const result = await rpc.handler(
      { ...prepareParams, attachmentId: 'attachment-1', throughSeq: 3 },
      {
        runtime,
        clientKind: 'runtime',
        pairedDeviceId: 'paired-device',
        connectionId: 'socket-1',
        transportGeneration: 1
      }
    )
    expect(result).toEqual(acknowledgement)
    expect(source.acknowledgeDestinationOutput).toHaveBeenCalledWith(
      expect.objectContaining({ throughSeq: 3 }),
      expect.objectContaining({ transportGeneration: 1 })
    )
  })

  it('rejects a stream when source transfer capability is dormant', async () => {
    const source = {
      getCapabilities: vi.fn(() => ({
        liveTransfer: false,
        destinationOutput: true,
        authoritativeExit: true
      })),
      assertStreamAuthorized: vi.fn(),
      snapshot: vi.fn(),
      onDestinationOutput: vi.fn(),
      onDestinationExit: vi.fn()
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const rpc = streamingMethod('pty.ownershipTransfer.streamSource')

    await expect(
      rpc.handler(
        { ...prepareParams, attachmentId: 'attachment-1' },
        {
          runtime,
          clientKind: 'runtime',
          pairedDeviceId: 'paired-device',
          connectionId: 'socket-1',
          signal: new AbortController().signal
        },
        vi.fn()
      )
    ).rejects.toThrow('pty_ownership_transfer_runtime_source_unavailable')
    expect(source.assertStreamAuthorized).not.toHaveBeenCalled()
  })

  it('rejects a stream whose full identity is stale', async () => {
    const source = {
      getCapabilities: vi.fn(() => ({
        liveTransfer: true,
        destinationOutput: true,
        authoritativeExit: true
      })),
      assertStreamAuthorized: vi.fn(),
      snapshot: vi.fn(() => ({ identity: { ...prepareParams, ownerLease: 'new-lease' } })),
      onDestinationOutput: vi.fn(),
      onDestinationExit: vi.fn()
    }
    const runtime = {
      getRuntimeId: () => 'runtime-source',
      getLocalPtyOwnershipTransferSource: () => source
    } as unknown as OrcaRuntimeService
    const rpc = streamingMethod('pty.ownershipTransfer.streamSource')

    await expect(
      rpc.handler(
        { ...prepareParams, attachmentId: 'attachment-1' },
        {
          runtime,
          clientKind: 'runtime',
          pairedDeviceId: 'paired-device',
          connectionId: 'socket-1',
          signal: new AbortController().signal
        },
        vi.fn()
      )
    ).rejects.toThrow('pty_ownership_transfer_runtime_source_unavailable')
    expect(source.assertStreamAuthorized).toHaveBeenCalledOnce()
    expect(source.onDestinationOutput).not.toHaveBeenCalled()
  })
})
