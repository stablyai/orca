import { afterEach, describe, expect, it, vi } from 'vitest'
import { PTY_CONSUMER_OWNER_GRACE_MS } from '../shared/pty-consumer-session'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

type Notification = { method: string; params: Record<string, unknown> }

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

function decode(buffer: Buffer): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  return JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
}

function notification(buffer: Buffer): Notification | null {
  const message = decode(buffer)
  return typeof message?.method === 'string' && message.id === undefined
    ? (message as Notification)
    : null
}

function responseResult(buffer: Buffer): Record<string, unknown> | null {
  const message = decode(buffer)
  return !message || message.id === undefined
    ? null
    : ((message.result as Record<string, unknown>) ?? null)
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('RelayPtySourcePublication cancellation and exit', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  async function createHarness(windowSu = 8, holdExitSettlement = false) {
    const writes: Buffer[] = []
    const exitSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const capacityIds: string[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        const frame = notification(data)
        if (frame?.method === 'pty.exit') {
          exitSettlements.push(onSettled)
          if (holdExitSettlement) {
            return true
          }
        }
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, (id) => capacityIds.push(id))
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: windowSu } }
      })
    )
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      publication.activate('pty-1', 'incarnation-1', {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => activationSettlements.push(callback)
      })
    ).toBe('opened')
    activationSettlements[0]({ ok: true })
    return { adapter, publication, exitSettlements, capacityIds, writes }
  }

  function cancelDeliveryFrame(
    requestId: number,
    activation: { clientGeneration: number; ownerGeneration: number; deliveryToken: string }
  ): Buffer {
    return requestFrame(requestId, 'pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: activation.clientGeneration,
      ownerGeneration: activation.ownerGeneration,
      deliveryToken: activation.deliveryToken
    })
  }

  function exitFrames(writes: Buffer[]): Notification[] {
    return writes
      .map(notification)
      .filter((frame): frame is Notification => frame?.method === 'pty.exit')
  }

  function ackFrame(
    requestId: number,
    activation: { clientGeneration: number; ownerGeneration: number; deliveryToken: string },
    creditedEndSu: number
  ): Buffer {
    return encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        method: 'pty.ackData',
        params: {
          acknowledgements: [
            {
              id: 'pty-1',
              clientGeneration: activation.clientGeneration,
              ownerGeneration: activation.ownerGeneration,
              deliveryToken: activation.deliveryToken,
              creditedEndSu
            }
          ]
        }
      },
      requestId,
      0
    )
  }

  it('retires the record when a client cancels, so the exit never seals a dead ledger', async () => {
    const harness = await createHarness()
    harness.publication.publish('pty-1', { data: 'data' }, false)
    const activation = harness.publication.receivingActivation('pty-1', 1)!

    dispatcher!.feed(cancelDeliveryFrame(2, activation))
    await flushRequests()

    expect(harness.publication.accepts('pty-1')).toBe(false)
    expect(harness.capacityIds).toContain('pty-1')
    expect(() =>
      expect(
        harness.publication.sealAndPublishExit({
          id: 'pty-1',
          code: 0,
          incarnationId: 'incarnation-1'
        })
      ).toBe(false)
    ).not.toThrow()
  })

  it('retires the record when the reconnect grace expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const harness = await createHarness()
      harness.publication.publish('pty-1', { data: 'data' }, false)

      dispatcher!.invalidateClient()
      vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS)

      expect(harness.publication.accepts('pty-1')).toBe(false)
      expect(harness.capacityIds).toContain('pty-1')
      expect(() =>
        expect(
          harness.publication.sealAndPublishExit({
            id: 'pty-1',
            code: 0,
            incarnationId: 'incarnation-1'
          })
        ).toBe(false)
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a fresh delivery when the same client re-attaches after a cancel', async () => {
    const harness = await createHarness()
    harness.publication.publish('pty-1', { data: 'data' }, false)
    const activation = harness.publication.receivingActivation('pty-1', 1)!
    dispatcher!.feed(cancelDeliveryFrame(2, activation))
    await flushRequests()

    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      harness.publication.activate('pty-1', 'incarnation-1', {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => activationSettlements.push(callback)
      })
    ).toBe('opened')
    activationSettlements[0]({ ok: true })

    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(exitFrames(harness.writes)).toHaveLength(1)
  })

  it('survives a cancel while the credit-mode exit frame is still in flight', async () => {
    const harness = await createHarness(8, true)
    harness.publication.publish('pty-1', { data: 'data' }, false)
    const activation = harness.publication.receivingActivation('pty-1', 1)!
    dispatcher!.feed(ackFrame(2, activation, 4))
    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(harness.exitSettlements).toHaveLength(1)

    dispatcher!.feed(cancelDeliveryFrame(3, activation))
    await flushRequests()
    expect(
      harness.writes.map(responseResult).filter((result) => result?.canceled === true)
    ).toHaveLength(1)
    // Why: A' keeps the record while the frame is in flight so no duplicate legacy exit escapes.
    expect(harness.publication.accepts('pty-1')).toBe(true)

    expect(() => harness.exitSettlements[0]({ ok: true })).not.toThrow()

    expect(exitFrames(harness.writes)).toHaveLength(1)
    expect(harness.capacityIds).toContain('pty-1')
    expect(harness.publication.exitPublicationSettled('pty-1')).toBe(true)
    expect(harness.publication.accepts('pty-1')).toBe(false)
  })

  it('retires the record after the in-flight exit frame fails on a canceled delivery', async () => {
    const harness = await createHarness(8, true)
    harness.publication.publish('pty-1', { data: 'data' }, false)
    const activation = harness.publication.receivingActivation('pty-1', 1)!
    dispatcher!.feed(ackFrame(2, activation, 4))
    harness.publication.sealAndPublishExit({ id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })
    dispatcher!.feed(cancelDeliveryFrame(3, activation))
    await flushRequests()
    const capacityBefore = harness.capacityIds.length

    expect(() =>
      harness.exitSettlements[0]({ ok: false, error: new Error('socket write failed') })
    ).not.toThrow()
    // Why: the delivery is gone, so no credit event will arrive — D's widened finally must retry.
    expect(harness.capacityIds.length).toBeGreaterThan(capacityBefore)

    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(harness.publication.accepts('pty-1')).toBe(false)
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      exitCommitted: 0,
      exitRolledBack: 1
    })
  })

  it('publishes exactly one exit for a healthy completion even when the retry re-runs', async () => {
    const harness = await createHarness()

    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(harness.publication.exitPublicationSettled('pty-1')).toBe(true)
    expect(harness.publication.accepts('pty-1')).toBe(false)

    expect(() =>
      expect(
        harness.publication.sealAndPublishExit({
          id: 'pty-1',
          code: 0,
          incarnationId: 'incarnation-1'
        })
      ).toBe(false)
    ).not.toThrow()
    expect(exitFrames(harness.writes)).toHaveLength(1)
  })
})
