import { afterEach, describe, expect, it, vi } from 'vitest'
import { PTY_CONSUMER_OWNER_GRACE_MS } from '../shared/pty-consumer-session'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function openFrame(id: number, overrides: Record<string, unknown> = {}): Buffer {
  return encodeJsonRpcFrame(
    {
      jsonrpc: '2.0',
      id,
      method: 'pty.openClient',
      params: {
        protocolVersion: 1,
        clientInstanceId: `client-${id}`,
        requestedRole: 'session-owner',
        ...overrides
      }
    },
    1,
    0
  )
}

function responseResult(buffer: Buffer): Record<string, unknown> {
  expect(buffer[0]).toBe(MessageType.Regular)
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8')).result
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('SshPtyConsumerSessionAdapter', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
    vi.useRealTimers()
  })

  it('does not activate owner authority until the grant write settles', async () => {
    const firstWrites: Buffer[] = []
    const firstSettlements: ((result: { ok: true } | { ok: false; error: Error }) => void)[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        firstWrites.push(Buffer.from(data))
        firstSettlements.push(onSettled)
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(openFrame(1))
    await flushRequests()

    const secondWrites: Buffer[] = []
    const secondId = dispatcher.attachClient(
      (data, onSettled) => {
        secondWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      { ...endpointIdentity, principal: 'competitor' }
    )
    dispatcher.feedClient(secondId, openFrame(2))
    await flushRequests()

    expect(responseResult(firstWrites[0])).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 1
    })
    expect(responseResult(secondWrites[0])).toMatchObject({ role: 'subscriber' })
    firstSettlements[0]({ ok: true })
  })

  it('rolls back owner election when the grant write fails', async () => {
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: false, error: new Error('send failed') })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(openFrame(1))
    await flushRequests()

    const retryWrites: Buffer[] = []
    const retryId = dispatcher.attachClient(
      (data, onSettled) => {
        retryWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(retryId, openFrame(2, { clientInstanceId: 'client-1' }))
    await flushRequests()

    expect(responseResult(retryWrites[0])).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2
    })
  })

  it('rejects an unproved constructor stream as an owner principal', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher((data, onSettled) => {
      writes.push(Buffer.from(data))
      onSettled({ ok: true })
      return true
    })
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(openFrame(1))
    await flushRequests()

    const response = JSON.parse(
      writes[0].subarray(13, 13 + writes[0].readUInt32BE(9)).toString('utf8')
    )
    expect(response.error.message).toContain('authentication')
  })

  it('rejects an invalid requested role instead of promoting it to owner', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(openFrame(1, { requestedRole: 'administrator' }))
    await flushRequests()

    const response = JSON.parse(
      writes[0].subarray(13, 13 + writes[0].readUInt32BE(9)).toString('utf8')
    )
    expect(response.error.message).toContain('requestedRole')
  })

  it('generation-fences per-PTY delivery pause notifications', async () => {
    const setPaused: { id: string; paused: boolean }[] = []
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', (id, paused) => {
      setPaused.push({ id, paused })
    })
    dispatcher.feed(openFrame(1))
    await flushRequests()

    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.setDeliveryPaused',
          params: {
            id: 'pty-1',
            paused: true,
            clientGeneration: 1,
            ownerGeneration: 1
          }
        },
        2,
        0
      )
    )
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.setDeliveryPaused',
          params: {
            id: 'pty-1',
            paused: false,
            clientGeneration: 99,
            ownerGeneration: 1
          }
        },
        3,
        0
      )
    )

    expect(setPaused).toEqual([{ id: 'pty-1', paused: true }])
  })

  it('token-fences V1 pause and clears an owned pause before detach retention', async () => {
    const setPaused: { id: string; paused: boolean }[] = []
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', (id, paused) => {
      setPaused.push({ id, paused })
    })
    dispatcher.feed(
      openFrame(1, {
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const identity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!

    for (const [sequence, deliveryToken] of [
      [2, 'stale-token'],
      [3, identity.deliveryToken]
    ] as const) {
      dispatcher.feed(
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            method: 'pty.setDeliveryPaused',
            params: {
              id: identity.id,
              paused: true,
              clientGeneration: identity.clientGeneration,
              ownerGeneration: identity.ownerGeneration,
              deliveryToken
            }
          },
          sequence,
          0
        )
      )
    }
    dispatcher.invalidateClient()

    expect(setPaused).toEqual([
      { id: 'pty-1', paused: true },
      { id: 'pty-1', paused: false }
    ])
  })

  it('clears the exact token pause before cancellation cleanup', async () => {
    const setPaused: { id: string; paused: boolean }[] = []
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', (id, paused) => {
      setPaused.push({ id, paused })
    })
    dispatcher.feed(
      openFrame(1, {
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const identity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.setDeliveryPaused',
          params: {
            id: identity.id,
            paused: true,
            clientGeneration: identity.clientGeneration,
            ownerGeneration: identity.ownerGeneration,
            deliveryToken: identity.deliveryToken
          }
        },
        2,
        0
      )
    )

    adapter.cancelDelivery(identity, 'restore-required')

    expect(setPaused).toEqual([
      { id: 'pty-1', paused: true },
      { id: 'pty-1', paused: false }
    ])
  })

  it('intersects the negotiated V1 source window without changing legacy omission', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        capabilities: {
          outputFlowControl: { versions: [1], requestedWindowSu: 512 * 1024 }
        }
      })
    )
    await flushRequests()

    expect(responseResult(writes[0])).toMatchObject({
      capabilities: {
        outputFlowControl: { version: 1, windowSu: 256 * 1024 }
      }
    })
  })

  it('keeps an old client token-free when the new relay supports V1', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(openFrame(1))
    await flushRequests()

    const grant = responseResult(writes[0])
    expect(grant).not.toHaveProperty('capabilities')
    expect(grant).not.toHaveProperty('deliveryToken')
  })

  it('accepts cumulative source ACKs only from the negotiated token owner', async () => {
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const identity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    adapter.appendSource(identity, {
      spanId: 'span-1',
      data: 'data',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })
    const reservation = adapter.reserveSourceSend(identity)!
    adapter.commitSourceSend(reservation)

    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: identity.id,
                clientGeneration: identity.clientGeneration,
                ownerGeneration: identity.ownerGeneration,
                deliveryToken: identity.deliveryToken,
                creditedEndSu: 4
              }
            ]
          }
        },
        2,
        0
      )
    )

    expect(adapter.sourceDeliverySnapshot(identity).creditedEndSu).toBe(4)
  })

  it('returns exact token-scoped cancellation proof before local cleanup', async () => {
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const identity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    adapter.appendSource(identity, {
      spanId: 'span-1',
      data: 'data',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })
    adapter.commitSourceSend(adapter.reserveSourceSend(identity)!)
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'pty.cancelDelivery',
          params: {
            id: identity.id,
            clientGeneration: identity.clientGeneration,
            ownerGeneration: identity.ownerGeneration,
            deliveryToken: identity.deliveryToken
          }
        },
        2,
        0
      )
    )
    await flushRequests()

    expect(responseResult(writes.at(-1)!)).toEqual({
      canceled: true,
      sentEndSu: 4,
      creditedEndSu: 0
    })
    expect(adapter.sourceDeliverySnapshot(identity).state).toBe('closed')
  })

  it('rotates reconnect ownership and transfers only exact retained recovery', async () => {
    const firstWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        firstWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        clientInstanceId: 'stable-client',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const firstGrant = responseResult(firstWrites[0])
    const oldIdentity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    adapter.appendSource(oldIdentity, {
      spanId: 'span-1',
      data: 'data',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })
    dispatcher.invalidateClient()

    const recoveredWrites: Buffer[] = []
    const recoveredClientId = dispatcher.attachClient(
      (data, onSettled) => {
        recoveredWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      recoveredClientId,
      openFrame(2, {
        clientInstanceId: 'stable-client',
        resume: {
          ownerGeneration: firstGrant.ownerGeneration,
          ownerLease: firstGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()

    const rotation = adapter.rotateDelivery(oldIdentity, recoveredClientId, 0)
    expect(rotation.recovery.map((sourceSpan) => sourceSpan.data)).toEqual(['data'])
    expect(rotation.identity).toMatchObject({
      providerGeneration: oldIdentity.providerGeneration,
      clientGeneration: 2,
      ownerGeneration: 2
    })
    expect(rotation.cancellation.replacementDeliveryToken).toBe(rotation.identity.deliveryToken)
  })

  it('keeps the old-token deadline after a resume grant until exact rotation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const firstWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        firstWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        clientInstanceId: 'stable-client',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const firstGrant = responseResult(firstWrites[0])
    const oldIdentity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    dispatcher.invalidateClient()

    const recoveredClientId = dispatcher.attachClient(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      recoveredClientId,
      openFrame(2, {
        clientInstanceId: 'stable-client',
        resume: {
          ownerGeneration: firstGrant.ownerGeneration,
          ownerLease: firstGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS)

    expect(adapter.sourceDeliverySnapshot(oldIdentity).state).toBe('closed')
  })

  it('closes retained source tokens when the dispatcher is disposed', async () => {
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')
    dispatcher.feed(
      openFrame(1, {
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    const identity = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!

    dispatcher.dispose()

    expect(adapter.sourceDeliverySnapshot(identity).state).toBe('closed')
  })
})
