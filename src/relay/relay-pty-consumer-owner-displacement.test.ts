import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
} from '../shared/pty-consumer-session'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function message(buffer: Buffer): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
}

function response(writes: readonly Buffer[], id: number): Record<string, unknown> | undefined {
  return writes.map(message).find((entry) => entry?.id === id) as
    | Record<string, unknown>
    | undefined
}

function ownerHelloParams(resume?: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: 1,
    clientInstanceId: 'client-1',
    requestedRole: 'session-owner',
    capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } },
    ...(resume ? { resume } : {})
  }
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('relay PTY consumer owner displacement', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('displaces a half-open owner and retains its deliveries for the reconnected client', async () => {
    // Why no settle deferral: a half-open peer is indistinguishable from a live one at the sink — writes
    // still "succeed" locally, so the relay never learns the owner is gone.
    const staleWrites: Buffer[] = []
    const closeStaleTransport = vi.fn()
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        staleWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true, close: closeStaleTransport },
      endpointIdentity
    )
    const detached: number[] = []
    dispatcher.onClientDetached((clientId) => detached.push(clientId))
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(requestFrame(1, 'pty.openClient', ownerHelloParams()))
    await flushRequests()
    const staleGrant = response(staleWrites, 1)!.result as Record<string, unknown>
    expect(adapter.deliveryMode(1)).toBe('source-owner')

    const staleDelivery = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    adapter.appendSource(staleDelivery, {
      spanId: 'span-1',
      data: 'tail',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })

    const reconnectWrites: Buffer[] = []
    const reconnectClientId = dispatcher.attachClient(
      (data, settle) => {
        reconnectWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      reconnectClientId,
      requestFrame(
        2,
        'pty.openClient',
        ownerHelloParams({
          ownerGeneration: staleGrant.ownerGeneration,
          ownerLease: staleGrant.ownerLease
        })
      )
    )
    await flushRequests()

    expect(response(reconnectWrites, 2)!.result).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 2
    })
    expect(adapter.deliveryMode(reconnectClientId)).toBe('source-owner')
    // Why: revocation is what bounds the takeover — the stale owner cannot open or drive deliveries again
    // even though its socket never closed.
    expect(adapter.deliveryMode(1)).toBe('subscriber')
    expect(adapter.openDelivery(1, 'pty-2', 'incarnation-1')).toBeNull()
    expect(detached).toContain(1)
    expect(closeStaleTransport).toHaveBeenCalledOnce()

    // Why: retained, not closed — the reconnected owner still has to rotate the stale delivery forward.
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1, graceTimers: 1 })
    const rotation = adapter.rotateDelivery(staleDelivery, reconnectClientId, 0)
    expect(rotation.identity).toMatchObject({ ownerGeneration: 2, clientGeneration: 2 })
    expect(rotation.recovery.map((span) => span.data)).toEqual(['tail'])
  })

  it('retains the incumbent delivery once when its socket closes mid-publication', async () => {
    const incumbentWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        incumbentWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(requestFrame(1, 'pty.openClient', ownerHelloParams()))
    await flushRequests()
    const incumbentGrant = response(incumbentWrites, 1)!.result as Record<string, unknown>
    const incumbentDelivery = adapter.openDelivery(1, 'pty-1', 'incarnation-1')!
    adapter.appendSource(incumbentDelivery, {
      spanId: 'span-1',
      data: 'tail',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })

    const reconnectWrites: Buffer[] = []
    let grantSettlement: ((result: SinkWriteSettlement) => void) | undefined
    const reconnectClientId = dispatcher.attachClient(
      (data, settle) => {
        reconnectWrites.push(Buffer.from(data))
        grantSettlement = settle
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      reconnectClientId,
      requestFrame(
        2,
        'pty.openClient',
        ownerHelloParams({
          ownerGeneration: incumbentGrant.ownerGeneration,
          ownerLease: incumbentGrant.ownerLease
        })
      )
    )
    await flushRequests()

    // Why this ordering: the incumbent's socket close and the replacement's grant write are independent
    // events, so detach-then-commit has to leave exactly one retention, not two competing ones.
    dispatcher.invalidateClient()
    grantSettlement!({ ok: true })

    expect(adapter.deliveryMode(reconnectClientId)).toBe('source-owner')
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1, graceTimers: 1 })
    const rotation = adapter.rotateDelivery(incumbentDelivery, reconnectClientId, 0)
    expect(rotation.identity).toMatchObject({ ownerGeneration: 2, clientGeneration: 2 })
    expect(adapter.getDebugSnapshot()).toMatchObject({ graceTimers: 0 })
  })

  it('keeps the incumbent owner when the replacement grant fails to publish', async () => {
    const incumbentWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        incumbentWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const detached: number[] = []
    dispatcher.onClientDetached((clientId) => detached.push(clientId))
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(requestFrame(1, 'pty.openClient', ownerHelloParams()))
    await flushRequests()
    const incumbentGrant = response(incumbentWrites, 1)!.result as Record<string, unknown>

    const reconnectWrites: Buffer[] = []
    let grantSettlement: ((result: SinkWriteSettlement) => void) | undefined
    const reconnectClientId = dispatcher.attachClient(
      (data, settle) => {
        reconnectWrites.push(Buffer.from(data))
        // Why: the takeover must not commit until the replacement grant is on the wire.
        grantSettlement = settle
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      reconnectClientId,
      requestFrame(
        2,
        'pty.openClient',
        ownerHelloParams({
          ownerGeneration: incumbentGrant.ownerGeneration,
          ownerLease: incumbentGrant.ownerLease
        })
      )
    )
    await flushRequests()

    expect(adapter.deliveryMode(1)).toBe('source-owner')
    expect(detached).not.toContain(1)

    grantSettlement!({ ok: false, error: new Error('reconnect socket closed mid-response') })
    expect(adapter.deliveryMode(1)).toBe('source-owner')
    expect(adapter.deliveryMode(reconnectClientId)).toBe('subscriber')

    // Why: the rolled-back attempt must leave the incumbent's lease reclaimable by the next reconnect.
    const retryWrites: Buffer[] = []
    const retryClientId = dispatcher.attachClient(
      (data, settle) => {
        retryWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      retryClientId,
      requestFrame(
        3,
        'pty.openClient',
        ownerHelloParams({
          ownerGeneration: incumbentGrant.ownerGeneration,
          ownerLease: incumbentGrant.ownerLease
        })
      )
    )
    await flushRequests()

    // Why generation 3: the rolled-back attempt consumed generation 2, but not the incumbent's lease.
    expect(response(retryWrites, 3)!.result).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 3
    })
    expect(adapter.deliveryMode(1)).toBe('subscriber')
    expect(detached).toContain(1)
  })

  it('fences an old proof while its replacement is live', async () => {
    const incumbentWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        incumbentWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a')

    dispatcher.feed(requestFrame(1, 'pty.openClient', ownerHelloParams()))
    await flushRequests()
    const incumbentGrant = response(incumbentWrites, 1)!.result as Record<string, unknown>
    const resume = {
      ownerGeneration: incumbentGrant.ownerGeneration,
      ownerLease: incumbentGrant.ownerLease
    }

    let firstReconnectSettlement: ((result: SinkWriteSettlement) => void) | undefined
    const firstReconnectWrites: Buffer[] = []
    const firstReconnectClientId = dispatcher.attachClient(
      (data, settle) => {
        firstReconnectWrites.push(Buffer.from(data))
        // Why ??=: the test settles the grant response, not whatever frame the dispatcher wrote last.
        firstReconnectSettlement ??= settle
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      firstReconnectClientId,
      requestFrame(2, 'pty.openClient', ownerHelloParams(resume))
    )
    await flushRequests()

    const retryWrites: Buffer[] = []
    const retryClientId = dispatcher.attachClient(
      (data, settle) => {
        retryWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      retryClientId,
      requestFrame(3, 'pty.openClient', ownerHelloParams(resume))
    )
    await flushRequests()

    expect(response(retryWrites, 3)!.error).toMatchObject({
      code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR
    })

    firstReconnectSettlement!({ ok: true })
    dispatcher.feedClient(
      retryClientId,
      requestFrame(4, 'pty.openClient', ownerHelloParams(resume))
    )
    await flushRequests()

    expect(response(retryWrites, 4)!.error).toMatchObject({
      code: PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
    })
    expect(adapter.deliveryMode(firstReconnectClientId)).toBe('source-owner')
    expect(adapter.deliveryMode(retryClientId)).toBe('subscriber')

    dispatcher.detachClient(firstReconnectClientId)
    dispatcher.feedClient(
      retryClientId,
      requestFrame(5, 'pty.openClient', ownerHelloParams(resume))
    )
    await flushRequests()

    expect(response(retryWrites, 5)!.result).toMatchObject({
      role: 'session-owner',
      ownerGeneration: 3,
      ownerLease: incumbentGrant.ownerLease
    })
    expect(adapter.deliveryMode(retryClientId)).toBe('source-owner')
  })
})
