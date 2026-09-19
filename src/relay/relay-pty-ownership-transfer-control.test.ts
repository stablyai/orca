import { describe, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type {
  RelayPtyOwnershipTransferSource,
  RelayPtyOwnershipTransferAdapterOptions
} from './relay-pty-ownership-transfer-adapter-contract'
import type { MethodHandler, RelayDispatcher, RequestContext } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../shared/pty-ownership-transfer-wire'

const source: RelayPtyOwnershipTransferSource = {
  terminalId: 'pty-1',
  incarnationId: 'inc-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 1
}
const identity = {
  version: 1 as const,
  bridgeId: 'bridge-1',
  terminalId: source.terminalId,
  incarnationId: source.incarnationId,
  ownerLease: source.ownerLease,
  sourceOwnerGeneration: source.sourceOwnerGeneration,
  destinationRuntimeId: 'runtime-1'
}
const commit = {
  ...identity,
  acceptedSourceEndSeq: 0,
  receipt: {
    receiptId: 'receipt-1',
    bridgeId: identity.bridgeId,
    acceptedSourceEndSeq: 0,
    committedAt: '2026-08-31T00:00:00.000Z'
  }
}

function create(
  applyOverride?: RelayPtyOwnershipTransferAdapterOptions['applyDestinationControl']
) {
  const apply = vi.fn(() => 'applied' as const)
  const exit = vi.fn()
  const adapter = new RelayPtyOwnershipTransferAdapter({
    resolveSource: () => source,
    authorizeRequest: () => true,
    setInputFenced: vi.fn(),
    writeDestinationInput: vi.fn(),
    publishDestinationOutput: vi.fn(),
    applyDestinationControl: applyOverride ?? apply,
    publishDestinationExit: exit
  })
  return { adapter, apply, exit }
}

describe('relay ownership-transfer destination control', () => {
  it('rechecks attachment authority at a delayed host mutation boundary', async () => {
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    const mutate = vi.fn()
    const { adapter } = create(async (_identity, _control, isAuthorized) => {
      await pending
      if (!isAuthorized?.()) {
        return 'unverifiable'
      }
      mutate()
      return 'applied'
    })
    adapter.prepare(identity)
    adapter.commit(commit)
    const attachment = { ...identity, attachmentId: 'delayed-control' }
    const owner = { clientId: 7, transportGeneration: 3, isStale: () => false }
    adapter.attach(attachment, owner)
    const result = adapter.control(
      { ...attachment, controlId: 'delayed', control: { kind: 'sendSignal', signal: 'SIGTERM' } },
      owner
    )
    adapter.attach(attachment, { ...owner, transportGeneration: 4 })
    resume()
    await expect(result).resolves.toMatchObject({ outcome: 'unverifiable' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('attaches, routes each control once, and rejects stale attachments', async () => {
    const { adapter, apply } = create()
    adapter.prepare(identity)
    adapter.commit(commit)
    expect(adapter.attach({ ...identity, attachmentId: 'a-1' }).executionVerdict).toBe('live')
    const request = {
      ...identity,
      attachmentId: 'a-1',
      controlId: 'c-1',
      control: { kind: 'resize', cols: 100, rows: 30 }
    } as const
    await expect(adapter.control(request)).resolves.toMatchObject({ outcome: 'applied' })
    await expect(adapter.control(request)).resolves.toMatchObject({ duplicate: true })
    expect(apply).toHaveBeenCalledTimes(1)
    await expect(adapter.control({ ...request, attachmentId: 'stale' })).rejects.toMatchObject({
      reason: 'stale-attachment'
    })
  })

  it('fences destination controls to the relay transport generation that attached them', async () => {
    const { adapter, apply } = create()
    adapter.prepare(identity)
    adapter.commit(commit)
    adapter.attach(
      { ...identity, attachmentId: 'a-generation-1' },
      { clientId: 7, transportGeneration: 3, isStale: () => false }
    )
    const request = {
      ...identity,
      attachmentId: 'a-generation-1',
      controlId: 'generation-control-1',
      control: { kind: 'resize', cols: 100, rows: 30 }
    } as const
    await expect(
      adapter.control(request, {
        clientId: 7,
        transportGeneration: 4,
        isStale: () => false
      })
    ).rejects.toMatchObject({ reason: 'stale-attachment' })
    await expect(
      adapter.control(request, {
        clientId: 7,
        transportGeneration: 3,
        isStale: () => false
      })
    ).resolves.toMatchObject({ outcome: 'applied' })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('retires the attachment id when its relay client detaches', async () => {
    const { adapter, apply } = create()
    adapter.prepare(identity)
    adapter.commit(commit)
    const handlers = new Map<string, MethodHandler>()
    let detached: ((clientId: number) => void) | undefined
    adapter.register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
      onClientDetached: (listener: (clientId: number) => void) => {
        detached = listener
        return () => {}
      }
    } as unknown as RelayDispatcher)
    await handlers.get(PTY_OWNERSHIP_TRANSFER_METHODS.attach)!(
      { ...identity, attachmentId: 'detaching-attachment' },
      { clientId: 9, transportGeneration: 1, isStale: () => false } satisfies RequestContext
    )
    detached?.(9)
    await expect(
      adapter.control(
        {
          ...identity,
          attachmentId: 'detaching-attachment',
          controlId: 'detached-control',
          control: { kind: 'clearBuffer' }
        },
        { clientId: 9, transportGeneration: 1, isStale: () => false }
      )
    ).rejects.toMatchObject({ reason: 'stale-attachment' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('publishes host-positive exit and recovers it on reattach', () => {
    const { adapter, exit } = create()
    adapter.prepare(identity)
    adapter.commit(commit)
    adapter.attach({ ...identity, attachmentId: 'a-1' })
    adapter.observeExit(source.terminalId, source.incarnationId, 0)
    expect(exit).toHaveBeenCalledWith(
      expect.objectContaining({ exit: expect.objectContaining({ verdict: 'exited', code: 0 }) }),
      undefined
    )
    // A reconnect must advance the durable route through the additive rekey RPC;
    // a plain attach cannot replace an existing route generation.
    expect(
      adapter.rekeyReconnect({
        ...identity,
        previousReconnectGeneration: 1,
        reconnectGeneration: 2,
        attachmentId: 'a-2'
      })
    ).toMatchObject({
      reconnectGeneration: 2,
      phase: 'committed'
    })
    expect(adapter.status(identity)).toMatchObject({
      phase: 'committed',
      exit: { verdict: 'exited', code: 0 }
    })
  })

  it('includes the committed attachment binding with the exit event', () => {
    const { adapter, exit } = create()
    adapter.prepare(identity)
    adapter.commit(commit)
    adapter.attach(
      { ...identity, attachmentId: 'a-bound' },
      { clientId: 12, transportGeneration: 4, isStale: () => false }
    )

    adapter.observeExit(source.terminalId, source.incarnationId, 0)

    expect(exit).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a-bound' }), {
      clientId: 12,
      transportGeneration: 4
    })
  })
})
