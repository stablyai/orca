import { afterEach, describe, expect, it } from 'vitest'
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

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

type Notification = { method: string; params: Record<string, unknown> }

function notification(buffer: Buffer): Notification | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return typeof message.method === 'string' && message.id === undefined ? message : null
}

function responseResult(buffer: Buffer): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return message.id === undefined ? null : (message.result ?? null)
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('RelayPtySourcePublication', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  async function createHarness(
    windowSu = 4,
    settleSourceImmediately = true,
    highWaterMark?: number,
    holdExitSettlement = false
  ) {
    const writes: Buffer[] = []
    const sourceSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const exitSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const capacityIds: string[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
        const frame = notification(data)
        if (frame?.method === 'pty.data' || frame?.method === 'pty.exit') {
          sourceSettlements.push(onSettled)
          if (frame.method === 'pty.exit') {
            exitSettlements.push(onSettled)
          }
          if (settleSourceImmediately && !(holdExitSettlement && frame.method === 'pty.exit')) {
            onSettled({ ok: true })
          }
        } else {
          onSettled({ ok: true })
        }
        return true
      },
      {
        supportsWriteCallback: true,
        ...(highWaterMark
          ? {
              writableLength: () => 0,
              writableHighWaterMark: () => highWaterMark
            }
          : {})
      },
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
    return { adapter, publication, sourceSettlements, exitSettlements, capacityIds, writes }
  }

  it('commits only from writer settlement and resumes exactly after cumulative ACK', async () => {
    const harness = await createHarness(4, false)
    expect(harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)).toBe(true)
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      outstandingSourceUnits: 0,
      sendCommitted: 0
    })

    harness.sourceSettlements[0]({ ok: true })
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      outstandingSourceUnits: 4,
      sendCommitted: 1
    })
    const first = harness.writes.map(notification).find((frame) => frame?.method === 'pty.data')!
    dispatcher!.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: 'pty-1',
                clientGeneration: first.params.clientGeneration,
                ownerGeneration: first.params.ownerGeneration,
                deliveryToken: first.params.deliveryToken,
                creditedEndSu: 4
              }
            ]
          }
        },
        2,
        0
      )
    )
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(2)
    await flushRequests()
  })

  it('settles a reentrant cumulative ACK only after the matching writer callback', async () => {
    const harness = await createHarness(4, false)
    expect(harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)).toBe(true)
    const first = harness.writes.map(notification).find((frame) => frame?.method === 'pty.data')!

    dispatcher!.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: 'pty-1',
                clientGeneration: first.params.clientGeneration,
                ownerGeneration: first.params.ownerGeneration,
                deliveryToken: first.params.deliveryToken,
                creditedEndSu: 4
              }
            ]
          }
        },
        2,
        0
      )
    )
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      outstandingSourceUnits: 0,
      sendCommitted: 0
    })

    harness.sourceSettlements[0]({ ok: true })

    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(2)
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      outstandingSourceUnits: 0,
      sendCommitted: 1
    })
  })

  it('slices source frames to the encoded HWM-minus-reserve capacity', async () => {
    const highWaterMark = 4096
    const harness = await createHarness(10_000, true, highWaterMark)
    const payload = '\u0000'.repeat(4000)

    expect(harness.publication.publish('pty-1', { data: payload }, false)).toBe(true)
    for (let turn = 0; turn < 4; turn++) {
      await flushRequests()
    }

    const frames = harness.writes.filter((buffer) => notification(buffer)?.method === 'pty.data')
    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames.map((buffer) => buffer.length))).toBeLessThanOrEqual(3072)
    expect(
      frames
        .map(notification)
        .map((frame) => frame!.params.data)
        .join('')
    ).toBe(payload)
  })

  it('keeps mixed legacy and V1 clients on distinct frame authority', async () => {
    const harness = await createHarness(8)
    const legacyWrites: Buffer[] = []
    dispatcher!.attachClient(
      (data, onSettled) => {
        legacyWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true }
    )

    harness.publication.publish('pty-1', { data: 'data' }, false)

    const sourceFrame = harness.writes
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    const oldGrant = harness.writes.map(responseResult).find((result) => result?.ownerLease)!
    const legacyFrame = legacyWrites
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    expect(sourceFrame.params).toMatchObject({
      data: 'data',
      sourceEndSu: 4,
      sourceLengthSu: 4
    })
    expect(legacyFrame.params).toEqual({ id: 'pty-1', data: 'data' })

    dispatcher!.invalidateClient()
    const replacementWrites: Buffer[] = []
    const replacementClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        replacementWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      replacementClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: oldGrant.ownerGeneration,
          ownerLease: oldGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 8 } }
      })
    )
    await flushRequests()
    harness.publication.publish('pty-1', { data: 'next' }, false)

    expect(
      replacementWrites.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(0)
    expect(
      legacyWrites.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(2)
  })

  it('detaches only a saturated subscriber while the V1 owner stays live', async () => {
    const harness = await createHarness(8)
    const detached: number[] = []
    const saturatedWrites: Buffer[] = []
    const healthyWrites: Buffer[] = []
    const heldSettlements: ((result: SinkWriteSettlement) => void)[] = []
    dispatcher!.onClientDetached((clientId) => detached.push(clientId))
    const saturatedId = dispatcher!.attachClient(
      (data, onSettled) => {
        saturatedWrites.push(Buffer.from(data))
        heldSettlements.push(onSettled)
        return false
      },
      {
        supportsWriteCallback: true,
        writableLength: () => 128 * 1024,
        writableHighWaterMark: () => 4 * 1024 * 1024
      }
    )
    const healthyId = dispatcher!.attachClient(
      (data, onSettled) => {
        healthyWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true }
    )
    const saturatedPayload = 's'.repeat(128 * 1024)
    let admitted = 0
    while (
      dispatcher!.tryNotifyPtyDataToClient(
        saturatedId,
        { id: 'saturated', data: saturatedPayload },
        () => {}
      )
    ) {
      admitted++
    }

    expect(admitted).toBeGreaterThan(0)
    expect(admitted).toBeLessThan(20)
    expect(harness.publication.publish('pty-1', { data: saturatedPayload }, false)).toBe(true)

    expect(detached).toEqual([saturatedId])
    expect(detached).not.toContain(healthyId)
    expect(saturatedWrites).toHaveLength(1)
    expect(heldSettlements).toHaveLength(1)
    expect(
      healthyWrites.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    expect(harness.publication.getDebugSnapshot()).toMatchObject({ sendCommitted: 1 })
  })

  it('keeps an early ACK retryable when its source write fails', async () => {
    const harness = await createHarness(4, false)
    harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)
    const first = harness.writes.map(notification).find((frame) => frame?.method === 'pty.data')!
    dispatcher!.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: 'pty-1',
                clientGeneration: first.params.clientGeneration,
                ownerGeneration: first.params.ownerGeneration,
                deliveryToken: first.params.deliveryToken,
                creditedEndSu: 4
              }
            ]
          }
        },
        2,
        0
      )
    )
    harness.sourceSettlements[0]({ ok: false, error: new Error('socket write failed') })

    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      outstandingSourceUnits: 0,
      sendCommitted: 0,
      sendRolledBack: 1
    })
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    expect(harness.adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1, sourceSu: 8 })
  })

  it('fences idle publication and pumping before the wait continuation', async () => {
    const harness = await createHarness(4)
    harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)
    const firstData = harness.writes
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    const fence = harness.publication.waitForPendingSend('pty-1')

    expect(harness.publication.publish('pty-1', { data: 'ijkl' }, false)).toBe(false)
    dispatcher!.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: 'pty-1',
                clientGeneration: firstData.params.clientGeneration,
                ownerGeneration: firstData.params.ownerGeneration,
                deliveryToken: firstData.params.deliveryToken,
                creditedEndSu: 4
              }
            ]
          }
        },
        2,
        0
      )
    )
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    expect(await fence).toBe(true)

    expect(
      harness.publication.activate('pty-1', 'incarnation-1', {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: () => {}
      })
    ).toBe('existing')
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(2)
    await flushRequests()
  })

  it('does not pump an old-token suffix after a successful fenced settlement', async () => {
    const harness = await createHarness(4, false)
    harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)
    const oldData = harness.writes.map(notification).find((frame) => frame?.method === 'pty.data')!
    const oldGrant = harness.writes.map(responseResult).find((result) => result?.ownerLease)!
    const fence = harness.publication.waitForPendingSend('pty-1')

    harness.sourceSettlements[0]({ ok: true })
    expect(await fence).toBe(true)
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
    dispatcher!.invalidateClient()

    const recoveredWrites: Buffer[] = []
    const recoveredClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        recoveredWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      recoveredClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: oldGrant.ownerGeneration,
          ownerLease: oldGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      harness.publication.activate(
        'pty-1',
        'incarnation-1',
        {
          clientId: recoveredClientId,
          isStale: () => false,
          sessionIdentity: endpointIdentity,
          onResponseSettled: (callback) => activationSettlements.push(callback)
        },
        {
          status: 'checkpoint',
          deliveryToken: String(oldData.params.deliveryToken),
          clientGeneration: Number(oldData.params.clientGeneration),
          ownerGeneration: Number(oldData.params.ownerGeneration),
          ptyIncarnation: 'incarnation-1',
          acceptedSourceEndSu: 4
        }
      )
    ).toMatchObject({ status: 'pending', checkpointSourceEndSu: 4, recoveryEndSu: 8 })
    activationSettlements[0]({ ok: true })

    const replacementData = recoveredWrites
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    expect(replacementData.params).toMatchObject({ data: 'efgh', sourceEndSu: 8 })
    expect(replacementData.params.deliveryToken).not.toBe(oldData.params.deliveryToken)
    expect(
      harness.writes.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(1)
  })

  it('recovers a receiver-accepted frame after detach rolls back its send', async () => {
    const harness = await createHarness(4, false)
    harness.publication.publish('pty-1', { data: 'data' }, false)
    const oldData = harness.writes.map(notification).find((frame) => frame?.method === 'pty.data')!
    const oldGrant = harness.writes.map(responseResult).find((result) => result?.ownerLease)!
    let fenceSettled = false
    const fence = harness.publication.waitForPendingSend('pty-1').then((result) => {
      fenceSettled = true
      return result
    })
    await Promise.resolve()
    expect(fenceSettled).toBe(false)

    dispatcher!.invalidateClient()
    expect(await fence).toBe(true)
    expect(harness.publication.getDebugSnapshot()).toMatchObject({
      sendCommitted: 0,
      sendRolledBack: 1
    })

    const recoveredWrites: Buffer[] = []
    const recoveredClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        recoveredWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      recoveredClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: oldGrant.ownerGeneration,
          ownerLease: oldGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const activation = harness.publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => activationSettlements.push(callback)
      },
      {
        status: 'checkpoint',
        deliveryToken: String(oldData.params.deliveryToken),
        clientGeneration: Number(oldData.params.clientGeneration),
        ownerGeneration: Number(oldData.params.ownerGeneration),
        ptyIncarnation: 'incarnation-1',
        acceptedSourceEndSu: 4
      }
    )
    expect(activation).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: 4,
      recoveryEndSu: 4
    })
    activationSettlements[0]({ ok: true })
    expect(
      recoveredWrites.map(notification).filter((frame) => frame?.method === 'pty.data')
    ).toHaveLength(0)
    expect(
      recoveredWrites.map(notification).find((frame) => frame?.method === 'pty.recoveryComplete')
        ?.params
    ).toMatchObject({ checkpointSourceEndSu: 4, recoveryEndSu: 4 })
    const beforeLateSettlement = harness.publication.getDebugSnapshot()

    harness.sourceSettlements[0]({ ok: true })

    expect(harness.publication.getDebugSnapshot()).toEqual(beforeLateSettlement)
  })

  it('publishes exit only after preceding source data settles', async () => {
    const harness = await createHarness(4, false)
    harness.publication.publish('pty-1', { data: 'data' }, false)
    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(false)

    harness.sourceSettlements[0]({ ok: true })
    expect(
      harness.publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(
      harness.writes
        .map(notification)
        .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
        .map((frame) => frame.method)
    ).toEqual(['pty.data', 'pty.exit'])
  })

  it('settles the recovery fence before sending buffered live output', async () => {
    const harness = await createHarness(4)
    harness.publication.publish('pty-1', { data: 'abcdefgh' }, false)
    const firstData = harness.writes
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    const firstGrant = harness.writes.map(responseResult).find((result) => result?.ownerLease)!
    dispatcher!.invalidateClient()

    const recoveredWrites: Buffer[] = []
    const recoverySettlements: ((result: SinkWriteSettlement) => void)[] = []
    const completionSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const recoveredClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        recoveredWrites.push(Buffer.from(data))
        const method = notification(data)?.method
        if (method === 'pty.data') {
          recoverySettlements.push(onSettled)
        } else if (method === 'pty.recoveryComplete') {
          completionSettlements.push(onSettled)
        } else {
          onSettled({ ok: true })
        }
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      recoveredClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: firstGrant.ownerGeneration,
          ownerLease: firstGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const activation = harness.publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => activationSettlements.push(callback)
      },
      {
        status: 'checkpoint',
        deliveryToken: String(firstData.params.deliveryToken),
        clientGeneration: Number(firstData.params.clientGeneration),
        ownerGeneration: Number(firstData.params.ownerGeneration),
        ptyIncarnation: 'incarnation-1',
        acceptedSourceEndSu: 4
      }
    )
    expect(activation).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: 4,
      recoveryEndSu: 8
    })
    activationSettlements[0]({ ok: true })
    expect(harness.publication.publish('pty-1', { data: 'ijkl' }, false)).toBe(false)

    expect(
      recoveredWrites.map(notification).filter((frame) => frame?.method === 'pty.recoveryComplete')
    ).toHaveLength(0)
    const recoveredData = recoveredWrites
      .map(notification)
      .find((frame) => frame?.method === 'pty.data')!
    harness.adapter.appendSource(
      {
        id: 'pty-1',
        providerGeneration: 1,
        clientGeneration: Number(recoveredData.params.clientGeneration),
        ownerGeneration: Number(recoveredData.params.ownerGeneration),
        ptyIncarnation: String(recoveredData.params.ptyIncarnation),
        deliveryToken: String(recoveredData.params.deliveryToken)
      },
      {
        spanId: 'buffered-live',
        data: 'ijkl',
        displayStart: 8,
        displayEnd: 12,
        splittable: true,
        transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
      }
    )
    recoverySettlements[0]({ ok: true })
    expect(
      recoveredWrites
        .map(notification)
        .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
        .map((frame) => frame.method)
    ).toEqual(['pty.deliveryCanceled', 'pty.data', 'pty.recoveryComplete'])
    dispatcher!.feedClient(
      recoveredClientId,
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id: 'pty-1',
                clientGeneration: recoveredData.params.clientGeneration,
                ownerGeneration: recoveredData.params.ownerGeneration,
                deliveryToken: recoveredData.params.deliveryToken,
                creditedEndSu: 8
              }
            ]
          }
        },
        3,
        0
      )
    )
    expect(harness.publication.publish('pty-1', { data: 'ijkl' }, false)).toBe(false)
    expect(
      recoveredWrites
        .map(notification)
        .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
        .map((frame) => frame.method)
    ).toEqual(['pty.deliveryCanceled', 'pty.data', 'pty.recoveryComplete'])

    completionSettlements[0]({ ok: true })
    expect(
      recoveredWrites
        .map(notification)
        .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
        .map((frame) => frame.method)
    ).toEqual(['pty.deliveryCanceled', 'pty.data', 'pty.recoveryComplete', 'pty.data'])
    expect(recoveredWrites.map(notification).at(-1)?.params).toMatchObject({
      data: 'ijkl',
      sourceEndSu: 12
    })
    await flushRequests()
  })
})
