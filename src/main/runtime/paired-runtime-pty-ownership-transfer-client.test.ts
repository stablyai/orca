import { describe, expect, it, vi } from 'vitest'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../../shared/pty-ownership-transfer-wire'
import { PairedRuntimePtyOwnershipTransferClient } from './paired-runtime-pty-ownership-transfer-client'
import type { SubscribePairedRuntimePtyOwnershipTransfer } from './paired-runtime-pty-ownership-transfer-rpc'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime-destination'
} as const

const outputCredit = {
  version: 1 as const,
  windowBytes: 512 * 1024,
  windowFrames: 256
}

function createAcknowledgementResponse(params: unknown) {
  const request = params as { attachmentId: string; throughSeq: number }
  return {
    id: 'ack-1',
    ok: true as const,
    result: {
      version: 1 as const,
      identity,
      attachmentId: request.attachmentId,
      throughSeq: request.throughSeq
    },
    _meta: { runtimeId: 'runtime-source' }
  }
}

function createAcknowledgingSubscription() {
  return {
    close: vi.fn(),
    sendRequest: vi.fn(async (_method: string, params: unknown) =>
      createAcknowledgementResponse(params)
    )
  }
}

describe('PairedRuntimePtyOwnershipTransferClient', () => {
  it('routes unary transfer calls through the exact paired environment', async () => {
    const result = {
      ...identity,
      version: 1 as const,
      phase: 'prepared' as const,
      sourceOutputEndSeq: 0,
      replayStartSeq: 1
    }
    const call = vi.fn().mockResolvedValue(result)
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', call)
    const controller = new AbortController()

    await expect(
      client.prepare({ ...identity, version: 1 }, { timeoutMs: 2_000, signal: controller.signal })
    ).resolves.toEqual(result)
    expect(call).toHaveBeenCalledWith(
      'environment-1',
      PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
      { ...identity, version: 1 },
      { timeoutMs: 2_000, signal: controller.signal }
    )
  })

  it('strictly rejects a response from another source identity', async () => {
    const call = vi.fn().mockResolvedValue({
      ...identity,
      bridgeId: 'bridge-other',
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', call)

    await expect(client.prepare({ ...identity, version: 1 })).rejects.toThrow(
      'pty_ownership_transfer_response_identity_mismatch'
    )
  })

  it('does not claim an authoritative exit or transport-loss stream', () => {
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn())

    expect('onDestinationExit' in client).toBe(false)
    expect('onTransportLost' in client).toBe(false)
    expect('onDestinationExitForAttachment' in client).toBe(true)
    expect('onDestinationTransportLost' in client).toBe(true)
  })

  it('keeps the production paired bridge fail-closed for unary mutation methods', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new Error('pty_ownership_transfer_paired_method_unsupported'))
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', call)

    await expect(client.prepare({ ...identity, version: 1 })).rejects.toThrow(
      'pty_ownership_transfer_paired_method_unsupported'
    )
  })

  it('shares one stream, gates readiness, and filters output/exit by attachment identity', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }
    const outputs: unknown[] = []
    const exits: unknown[] = []
    const lost = vi.fn()
    const disposeOutput = client.onDestinationOutput(
      capabilities,
      identity,
      'attachment-1',
      (event) => {
        outputs.push(event)
      }
    )
    const disposeExit = client.onDestinationExitForAttachment(
      capabilities,
      identity,
      'attachment-1',
      (event) => exits.push(event)
    )
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)

    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe.mock.calls[0]?.[2]).toMatchObject({ outputCredit })
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    let settled = false
    void ready.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await expect(ready).resolves.toBeUndefined()
    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'ok' }
    })
    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-other',
      frame: { seq: 2, data: 'ignore' }
    })
    streamCallbacks?.onEvent({
      kind: 'exit',
      event: {
        ...identity,
        version: 1,
        attachmentId: 'attachment-1',
        exit: {
          verdict: 'exited',
          eventId: 'exit-1',
          observedAt: '2026-08-31T12:00:00.000Z'
        }
      }
    })
    await vi.waitFor(() => expect(outputs).toHaveLength(1))
    expect(exits).toHaveLength(1)

    streamCallbacks?.onClose()
    expect(lost).toHaveBeenCalledOnce()
    disposeOutput()
    disposeExit()
  })

  it('marks transport lost when a post-ready frame is malformed', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', vi.fn())
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await expect(ready).resolves.toBeUndefined()

    streamCallbacks?.onEvent({ kind: 'output', identity, attachmentId: 'attachment-1', frame: {} })
    expect(lost).toHaveBeenCalledOnce()
  })

  it('marks transport lost when the paired output stream skips a sequence', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', vi.fn())
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await expect(ready).resolves.toBeUndefined()

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'one' }
    })
    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 3, data: 'three' }
    })

    expect(lost).toHaveBeenCalledOnce()
  })

  it('allows an exact duplicate but fences a conflicting duplicate sequence', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }
    const outputs: unknown[] = []
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', (event) => {
      outputs.push(event)
    })
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await expect(ready).resolves.toBeUndefined()

    const frame = {
      kind: 'output' as const,
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'one' }
    }
    streamCallbacks?.onEvent(frame)
    streamCallbacks?.onEvent(frame)
    await vi.waitFor(() => expect(outputs).toHaveLength(1))
    expect(lost).not.toHaveBeenCalled()

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'changed' }
    })
    expect(lost).toHaveBeenCalledOnce()
  })

  it('marks transport lost when a paired output frame is explicitly truncated', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', vi.fn())
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await expect(ready).resolves.toBeUndefined()

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'partial', truncated: true }
    })

    expect(lost).toHaveBeenCalledOnce()
  })

  it('fails readiness closed when the source omits cumulative output credit', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const lost = vi.fn()
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')

    streamCallbacks?.onEvent({ kind: 'ready', identity, attachmentId: 'attachment-1' })

    await expect(ready).rejects.toThrow('pty_ownership_transfer_output_credit_unsupported')
    expect(lost).toHaveBeenCalledOnce()
  })

  it('fails readiness closed when the source omits the negotiated frame window', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const lost = vi.fn()
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')

    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit: { version: 1, windowBytes: 512 * 1024 }
    })

    await expect(ready).rejects.toThrow('pty_ownership_transfer_output_credit_invalid')
    expect(lost).toHaveBeenCalledOnce()
  })

  it('acknowledges output only after the destination listener durably accepts it', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscription = createAcknowledgingSubscription()
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return subscription
    })
    let resolveAccepted!: () => void
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    client.onDestinationOutput(capabilities, identity, 'attachment-1', () => accepted)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await ready

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 7, data: 'durable' }
    })
    await Promise.resolve()
    expect(subscription.sendRequest).not.toHaveBeenCalled()

    resolveAccepted()
    await vi.waitFor(() => expect(subscription.sendRequest).toHaveBeenCalledOnce())
    expect(subscription.sendRequest.mock.calls[0]?.[1]).toMatchObject({ throughSeq: 7 })
  })

  it('does not acknowledge output rejected by the durable destination listener', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscription = createAcknowledgingSubscription()
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return subscription
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', async () => {
      throw new Error('durable-destination-rejected')
    })
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await ready

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'reject-me' }
    })

    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce())
    expect(subscription.sendRequest).not.toHaveBeenCalled()
  })

  it('coalesces durable delivery into cumulative acknowledgements', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    let releaseFirstAcknowledgement!: () => void
    const sendRequest = vi.fn((_method: string, params: unknown) => {
      if (sendRequest.mock.calls.length === 1) {
        return new Promise<ReturnType<typeof createAcknowledgementResponse>>((resolve) => {
          releaseFirstAcknowledgement = () => resolve(createAcknowledgementResponse(params))
        })
      }
      return Promise.resolve(createAcknowledgementResponse(params))
    })
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return { close: vi.fn(), sendRequest }
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const listener = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', listener)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await ready

    for (const seq of [1, 2, 3]) {
      streamCallbacks?.onEvent({
        kind: 'output',
        identity,
        attachmentId: 'attachment-1',
        frame: { seq, data: String(seq) }
      })
    }
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3))
    expect(sendRequest).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ throughSeq: 1 })

    releaseFirstAcknowledgement()
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2))
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ throughSeq: 3 })
  })

  it('marks the stream lost when an acknowledgement response is stale', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscription = createAcknowledgingSubscription()
    subscription.sendRequest.mockImplementation(async (_method, params) => ({
      ...createAcknowledgementResponse(params),
      result: {
        ...createAcknowledgementResponse(params).result,
        attachmentId: 'attachment-stale'
      }
    }))
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return subscription
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const lost = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', vi.fn())
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await ready

    streamCallbacks?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'one' }
    })

    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce())
  })

  it('creates a fresh stream that can replay an unacknowledged frame after reconnect', async () => {
    const streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3][] = []
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks.push(callbacks)
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const firstDelivery = new Promise<void>(() => {})
    client.onDestinationOutput(capabilities, identity, 'attachment-1', () => firstDelivery)
    const firstReady = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks[0]?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await firstReady
    streamCallbacks[0]?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'replay-me' }
    })
    streamCallbacks[0]?.onClose()

    const replayed = vi.fn()
    client.onDestinationOutput(capabilities, identity, 'attachment-1', replayed)
    const secondReady = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks[1]?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await secondReady
    streamCallbacks[1]?.onEvent({
      kind: 'output',
      identity,
      attachmentId: 'attachment-1',
      frame: { seq: 1, data: 'replay-me' }
    })

    await vi.waitFor(() => expect(replayed).toHaveBeenCalledOnce())
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('marks transport lost when the credited source reports output loss', async () => {
    let streamCallbacks: Parameters<SubscribePairedRuntimePtyOwnershipTransfer>[3] | undefined
    const subscribe = vi.fn(async (_environmentId, _method, _params, callbacks) => {
      streamCallbacks = callbacks
      return createAcknowledgingSubscription()
    })
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const lost = vi.fn()
    client.onDestinationTransportLost(capabilities, identity, 'attachment-1', lost)
    const ready = client.waitForDestinationStreamReady(capabilities, identity, 'attachment-1')
    streamCallbacks?.onEvent({
      kind: 'ready',
      identity,
      attachmentId: 'attachment-1',
      outputCredit
    })
    await ready

    streamCallbacks?.onEvent({ kind: 'loss', code: 'output_credit_exhausted' })

    expect(lost).toHaveBeenCalledOnce()
  })

  it('keeps stream keys distinct for identities that share delimiters', async () => {
    const firstIdentity = {
      ...identity,
      bridgeId: 'bridge',
      incarnationId: 'incarnation:owner',
      ownerLease: 'lease',
      terminalId: 'terminal-a'
    }
    const secondIdentity = {
      ...identity,
      bridgeId: 'bridge:incarnation',
      incarnationId: 'owner',
      ownerLease: 'lease',
      terminalId: 'terminal-b'
    }
    const subscribe = vi.fn(async () => ({ close: vi.fn() }))
    const client = new PairedRuntimePtyOwnershipTransferClient('environment-1', vi.fn(), subscribe)
    const capabilities: PtyOwnershipBridgeCapabilities = {
      protocolVersions: [1],
      maxReplayBytes: 128 * 1024,
      maxInputIds: 4096,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true,
      authoritativeExit: true
    }

    client.onDestinationOutput(capabilities, firstIdentity, 'attachment-1', vi.fn())
    client.onDestinationOutput(capabilities, secondIdentity, 'attachment-1', vi.fn())
    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})

const capabilities: PtyOwnershipBridgeCapabilities = {
  protocolVersions: [1],
  maxReplayBytes: 128 * 1024,
  maxInputIds: 4096,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  authoritativeExit: true
}
