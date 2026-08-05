import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION,
  AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION
} from '../../shared/agent-session-host-authority'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { encodeFrame, HEADER_LENGTH, MessageType } from '../ssh/relay-protocol'
import { SshPtyProvider } from './ssh-pty-provider'

function createTransport(): MultiplexerTransport & {
  deliver: (data: Buffer) => void
  written: Buffer[]
} {
  let deliver = (_data: Buffer): void => {}
  const written: Buffer[] = []
  return {
    write: (data) => {
      written.push(data)
    },
    onData: (callback) => {
      deliver = callback
    },
    onClose: () => {},
    deliver: (data) => deliver(data),
    written
  }
}

function rpcFrame(payload: Record<string, unknown>, sequence: number): Buffer {
  return encodeFrame(MessageType.Regular, sequence, 0, Buffer.from(JSON.stringify(payload)))
}

function responseFrame(id: number, result: unknown, sequence: number): Buffer {
  return rpcFrame({ jsonrpc: '2.0', id, result }, sequence)
}

function notificationFrame(
  method: string,
  params: Record<string, unknown>,
  sequence: number
): Buffer {
  return rpcFrame({ jsonrpc: '2.0', method, params }, sequence)
}

function requestPayloads(transport: ReturnType<typeof createTransport>): Record<string, unknown>[] {
  return transport.written.flatMap((frame) => {
    if (frame[0] !== MessageType.Regular) {
      return []
    }
    const payloadLength = frame.readUInt32BE(9)
    return [
      JSON.parse(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength).toString()) as Record<
        string,
        unknown
      >
    ]
  })
}

async function waitForRequest(
  transport: ReturnType<typeof createTransport>,
  method: string
): Promise<Record<string, unknown>> {
  // Why: post-shutdown cancelDelivery is scheduled through async catch/rollback chains.
  // A fixed microtask budget flakes under CI load (esp. Node 26 shards); yield real turns.
  return await vi.waitFor(
    () => {
      const request = requestPayloads(transport).find((payload) => payload.method === method)
      if (!request) {
        throw new Error(`request not dispatched: ${method}`)
      }
      return request
    },
    { timeout: 1000, interval: 1 }
  )
}

describe('SSH fresh agent-session create operations', () => {
  const request = vi.fn()
  let provider: SshPtyProvider

  beforeEach(() => {
    request.mockReset()
    provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  it('sends operation identity only to a capable relay', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities'
        ? { agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION }
        : { id: 'pty-operation', incarnationId: 'incarnation-operation' }
    )

    await provider.spawn({
      cols: 80,
      rows: 24,
      command: 'codex',
      agentSessionCreateOperationId: 'a'.repeat(43)
    })

    expect(request).toHaveBeenNthCalledWith(1, 'pty.getCapabilities', undefined, {
      signal: undefined,
      timeoutMs: 5_000
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'pty.spawn',
      {
        cols: 80,
        rows: 24,
        cwd: undefined,
        env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'true' },
        command: 'codex',
        agentSessionCreateOperationId: 'a'.repeat(43)
      },
      expect.objectContaining({ beforeResolve: expect.any(Function) })
    )
  })

  it('does not downgrade after structured dispatch reaches an old relay', async () => {
    request.mockResolvedValueOnce({})

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        agentSessionCreateOperationId: 'b'.repeat(43)
      })
    ).rejects.toThrow('execution_owner_unavailable')
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps a client-selected old-relay spawn byte-for-byte legacy', async () => {
    request.mockResolvedValueOnce({ id: 'pty-legacy' })

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        command: 'codex'
      })
    ).resolves.toMatchObject({ id: 'ssh:conn-1@@pty-legacy' })

    expect(request).toHaveBeenNthCalledWith(
      1,
      'pty.spawn',
      {
        cols: 80,
        rows: 24,
        cwd: undefined,
        env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'true' },
        command: 'codex'
      },
      expect.objectContaining({ beforeResolve: expect.any(Function) })
    )
  })

  it('re-probes a negative capability after an in-place relay upgrade', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })

    await expect(provider.supportsAgentSessionCreateOperations()).resolves.toBe(false)
    await expect(provider.supportsAgentSessionCreateOperations()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps a shared capability probe alive when one waiter disconnects', async () => {
    let finishProbe!: (result: { agentSessionCreateOperationVersion: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const abort = new AbortController()
    const canceled = provider.supportsAgentSessionCreateOperations({ signal: abort.signal })
    const live = provider.supportsAgentSessionCreateOperations()

    abort.abort()
    await expect(canceled).resolves.toBe(false)
    finishProbe({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await expect(live).resolves.toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not dispatch create after cancellation during its capability gate', async () => {
    let finishProbe!: (result: { agentSessionCreateOperationVersion: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const abort = new AbortController()
    const spawn = provider.spawn({
      cols: 80,
      rows: 24,
      command: 'codex',
      agentSessionCreateOperationId: 'd'.repeat(43),
      signal: abort.signal
    })

    abort.abort()
    finishProbe({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await expect(spawn).rejects.toThrow('client_disconnected')
    expect(request.mock.calls.map((call) => call[0])).toEqual(['pty.getCapabilities'])
  })

  it('fences a malformed successful structured-create response', async () => {
    request
      .mockResolvedValueOnce({
        agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
      })
      .mockResolvedValueOnce({ id: 'pty-without-incarnation' })

    const failure = await provider
      .spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        agentSessionCreateOperationId: 'c'.repeat(43)
      })
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({
      message: 'execution_owner_unavailable',
      agentSessionOperationOutcome: 'unknown'
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('withholds same-turn source data until claim validation and isolates rollback', async () => {
    const transport = createTransport()
    const mux = new SshChannelMultiplexer(transport)
    const exactProvider = new SshPtyProvider('conn-1', mux)
    const onData = vi.fn()
    exactProvider.onData(onData)
    const claim = {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'codex' as const
    }
    const surface = {
      worktreeId: 'worktree',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_claimed'
    }
    const spawn = exactProvider.spawn({
      cols: 80,
      rows: 24,
      agentSessionEnsure: { claim, surface }
    })
    const capabilityRequest = await waitForRequest(transport, 'pty.getCapabilities')
    transport.deliver(
      responseFrame(
        capabilityRequest.id as number,
        { agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION },
        1
      )
    )
    const spawnRequest = await waitForRequest(transport, 'pty.spawn')
    const oldActivation = {
      status: 'pending',
      clientGeneration: 2,
      ownerGeneration: 3,
      ptyIncarnation: 'incarnation-old',
      deliveryToken: 'token-old',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 3
    }
    transport.deliver(
      Buffer.concat([
        responseFrame(
          spawnRequest.id as number,
          {
            id: 'pty-1',
            incarnationId: 'incarnation-old',
            sourceActivation: oldActivation,
            agentSessionEnsure: {
              disposition: 'created',
              owner: {
                claim: { ...claim, identityDigest: 'c'.repeat(43) },
                generation: 'generation-old',
                phase: 'live',
                ptyId: 'pty-1',
                surface
              }
            }
          },
          2
        ),
        notificationFrame(
          'pty.data',
          {
            id: 'pty-1',
            data: 'old',
            ptyIncarnation: 'incarnation-old',
            deliveryToken: 'token-old',
            clientGeneration: 2,
            ownerGeneration: 3,
            sourceEndSu: 3,
            sourceLengthSu: 3
          },
          3
        )
      ])
    )

    expect(onData).not.toHaveBeenCalled()
    expect(exactProvider.hasPty('ssh:conn-1@@pty-1')).toBe(false)
    const shutdownRequest = await waitForRequest(transport, 'pty.shutdown')
    transport.deliver(responseFrame(shutdownRequest.id as number, null, 4))
    const cancelRequest = await waitForRequest(transport, 'pty.cancelDelivery')
    let spawnSettled = false
    void spawn.then(
      () => {
        spawnSettled = true
      },
      () => {
        spawnSettled = true
      }
    )
    await Promise.resolve()
    expect(spawnSettled).toBe(false)
    expect(cancelRequest.params).toEqual({
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-old'
    })

    const replacement = exactProvider.spawn({ cols: 80, rows: 24 })
    const replacementRequest = requestPayloads(transport).findLast(
      (payload) => payload.method === 'pty.spawn'
    )
    expect(replacementRequest).toBeDefined()
    transport.deliver(
      Buffer.concat([
        responseFrame(
          replacementRequest!.id as number,
          {
            id: 'pty-1',
            incarnationId: 'incarnation-new',
            sourceActivation: {
              ...oldActivation,
              clientGeneration: 4,
              ownerGeneration: 5,
              ptyIncarnation: 'incarnation-new',
              deliveryToken: 'token-new'
            }
          },
          5
        ),
        notificationFrame(
          'pty.data',
          {
            id: 'pty-1',
            data: 'new',
            ptyIncarnation: 'incarnation-new',
            deliveryToken: 'token-new',
            clientGeneration: 4,
            ownerGeneration: 5,
            sourceEndSu: 3,
            sourceLengthSu: 3
          },
          6
        )
      ])
    )
    await expect(replacement).resolves.toMatchObject({ incarnationId: 'incarnation-new' })
    expect(onData.mock.calls.map(([payload]) => payload.data)).toEqual(['new'])

    transport.deliver(
      responseFrame(
        cancelRequest.id as number,
        { canceled: true, sentEndSu: 3, creditedEndSu: 0 },
        7
      )
    )
    await expect(spawn).rejects.toThrow('agent_session_ownership_unknown')
    expect(exactProvider.hasPty('ssh:conn-1@@pty-1')).toBe(true)
    expect(
      requestPayloads(transport).filter((payload) => payload.method === 'pty.cancelDelivery')
    ).toHaveLength(1)
    mux.dispose()
  })
})
