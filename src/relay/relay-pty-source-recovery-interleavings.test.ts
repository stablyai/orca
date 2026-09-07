import { afterEach, describe, expect, it } from 'vitest'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { PtySourceRecoveryRequest } from '../shared/pty-source-recovery-contract'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { RelayPtySourceCreditLedger } from './pty-source-credit-ledger'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function deliveryIdentity(
  deliveryToken: string,
  overrides: Partial<PtySourceDeliveryIdentity> = {}
): PtySourceDeliveryIdentity {
  return {
    id: 'pty-1',
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: 'incarnation-1',
    deliveryToken,
    ...overrides
  }
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

function responseResult(
  writes: readonly Buffer[],
  id: number
): Record<string, unknown> | undefined {
  const response = writes.map(message).find((entry) => entry?.id === id)
  return response?.result as Record<string, unknown> | undefined
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('relay PTY source recovery interleavings', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('retains failed exit delivery for a late ACK and exact sealed recovery', () => {
    const ledger = new RelayPtySourceCreditLedger()
    const oldIdentity = deliveryIdentity('old-token')
    const replacement = deliveryIdentity('replacement-token', {
      clientGeneration: 2,
      ownerGeneration: 2
    })
    ledger.open(oldIdentity, 4)
    ledger.append(oldIdentity, {
      spanId: 'tail',
      data: 'tail',
      displayStart: 0,
      displayEnd: 4,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })
    const send = ledger.reserveNextSend(oldIdentity)!
    ledger.commitSend(send)
    ledger.seal(oldIdentity)

    ledger.settleExitPublication(oldIdentity, {
      ok: false,
      error: new Error('socket closed before exit publication')
    })
    ledger.acknowledge(oldIdentity, {
      id: oldIdentity.id,
      clientGeneration: oldIdentity.clientGeneration,
      ownerGeneration: oldIdentity.ownerGeneration,
      deliveryToken: oldIdentity.deliveryToken,
      creditedEndSu: 4
    })
    const rotation = ledger.rotate(oldIdentity, replacement, 4, 4)

    expect(rotation.recovery).toEqual([])
    expect(ledger.snapshot(replacement)).toMatchObject({
      state: 'sealed-unsettled',
      creditedEndSu: 4,
      receivedEndSu: 4,
      exitPublished: false
    })
    expect(ledger.cancel(replacement, 'client-request')).toMatchObject({
      deliveryToken: 'replacement-token',
      remainingStartSu: 4,
      remainingEndSu: 4
    })
    expect(ledger.snapshot(replacement).state).toBe('closed')
  })

  it('retries a failed exit publication after exact owner recovery', async () => {
    const primaryWrites: Buffer[] = []
    let exitSettlement: ((result: SinkWriteSettlement) => void) | undefined
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        primaryWrites.push(Buffer.from(data))
        if (message(data)?.method === 'pty.exit') {
          exitSettlement = settle
          return true
        }
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const activationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    publication.activate('pty-1', 'incarnation-1', {
      clientId: 1,
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (callback) => activationSettlements.push(callback)
    })
    activationSettlements[0]({ ok: true })
    publication.publish('pty-1', { data: 'tail' }, false)
    const oldData = primaryWrites.map(message).find((entry) => entry?.method === 'pty.data')!
      .params as Record<string, unknown>
    const oldGrant = responseResult(primaryWrites, 1)!

    expect(
      publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(publication.exitPublicationSettled('pty-1')).toBe(false)
    exitSettlement!({ ok: false, error: new Error('socket closed') })
    expect(publication.exitPublicationSettled('pty-1')).toBe(false)
    expect(publication.getDebugSnapshot()).toMatchObject({
      sealedUnsettled: 1,
      exitCommitted: 0,
      exitRolledBack: 1
    })
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1, sourceSu: 4 })

    const recoveredWrites: Buffer[] = []
    const recoveredClientId = dispatcher.attachClient(
      (data, settle) => {
        recoveredWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
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
    const recoveredActivationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const recovered = publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => recoveredActivationSettlements.push(callback)
      },
      {
        status: 'checkpoint',
        deliveryToken: String(oldData.deliveryToken),
        clientGeneration: Number(oldData.clientGeneration),
        ownerGeneration: Number(oldData.ownerGeneration),
        ptyIncarnation: 'incarnation-1',
        acceptedSourceEndSu: 4
      }
    )
    recoveredActivationSettlements[0]({ ok: true })

    expect(recovered).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: 4,
      recoveryEndSu: 4
    })
    expect(
      publication.sealAndPublishExit({
        id: 'pty-1',
        code: 0,
        incarnationId: 'incarnation-1'
      })
    ).toBe(true)
    expect(publication.exitPublicationSettled('pty-1')).toBe(true)
    expect(
      recoveredWrites.map(message).filter((entry) => entry?.method === 'pty.exit')
    ).toHaveLength(1)
  })

  it('keeps failed recovery activation private and retryable until exact response settles', async () => {
    const primaryWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        primaryWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
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
    expect(publication.publish('pty-1', { data: 'abcdefgh' }, false)).toBe(true)
    const oldData = primaryWrites.map(message).find((entry) => entry?.method === 'pty.data')!
      .params as Record<string, unknown>
    const oldGrant = responseResult(primaryWrites, 1)!
    dispatcher.invalidateClient()

    const recoveredWrites: Buffer[] = []
    const recoveredClientId = dispatcher.attachClient(
      (data, settle) => {
        recoveredWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
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
    const recoveryRequest: PtySourceRecoveryRequest = {
      status: 'checkpoint',
      deliveryToken: String(oldData.deliveryToken),
      clientGeneration: Number(oldData.clientGeneration),
      ownerGeneration: Number(oldData.ownerGeneration),
      ptyIncarnation: 'incarnation-1',
      acceptedSourceEndSu: 4
    }
    const firstActivationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const firstRecovery = publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => firstActivationSettlements.push(callback)
      },
      recoveryRequest
    )
    expect(firstRecovery).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: 4,
      recoveryEndSu: 8
    })

    firstActivationSettlements[0]({ ok: false, error: new Error('response publication failed') })
    expect(publication.getDebugSnapshot()).toMatchObject({ active: 0, activating: 1 })
    const writesBeforeRetry = recoveredWrites.length
    publication.onCreditAvailable('pty-1')
    expect(recoveredWrites).toHaveLength(writesBeforeRetry)

    const retryActivationSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const retriedRecovery = publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => retryActivationSettlements.push(callback)
      },
      recoveryRequest
    )

    expect(retriedRecovery).toEqual(firstRecovery)
    retryActivationSettlements[0]({ ok: true })
    expect(publication.getDebugSnapshot()).toMatchObject({ active: 1, activating: 0 })
  })

  it('rolls back a failed recovery fence and republishes it for the next exact owner', async () => {
    const primaryWrites: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, settle) => {
        primaryWrites.push(Buffer.from(data))
        settle({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const firstActivation: ((result: SinkWriteSettlement) => void)[] = []
    publication.activate('pty-1', 'incarnation-1', {
      clientId: 1,
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (callback) => firstActivation.push(callback)
    })
    firstActivation[0]({ ok: true })
    publication.publish('pty-1', { data: 'abcdefgh' }, false)
    const firstData = primaryWrites.map(message).find((entry) => entry?.method === 'pty.data')!
      .params as Record<string, unknown>
    const firstGrant = responseResult(primaryWrites, 1)!
    dispatcher.invalidateClient()

    const recoveredWrites: Buffer[] = []
    let recoveryDataSettlement: ((result: SinkWriteSettlement) => void) | undefined
    let failedCompletionSettlement: ((result: SinkWriteSettlement) => void) | undefined
    const recoveredClientId = dispatcher.attachClient(
      (data, settle) => {
        recoveredWrites.push(Buffer.from(data))
        const method = message(data)?.method
        if (method === 'pty.data') {
          recoveryDataSettlement = settle
        } else if (method === 'pty.recoveryComplete') {
          failedCompletionSettlement = settle
        } else {
          settle({ ok: true })
        }
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
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
    const recoveredGrant = responseResult(recoveredWrites, 2)!
    const recoveredActivation: ((result: SinkWriteSettlement) => void)[] = []
    publication.activate(
      'pty-1',
      'incarnation-1',
      {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => recoveredActivation.push(callback)
      },
      {
        status: 'checkpoint',
        deliveryToken: String(firstData.deliveryToken),
        clientGeneration: Number(firstData.clientGeneration),
        ownerGeneration: Number(firstData.ownerGeneration),
        ptyIncarnation: 'incarnation-1',
        acceptedSourceEndSu: 4
      }
    )
    recoveredActivation[0]({ ok: true })
    recoveryDataSettlement!({ ok: true })
    const recoveredData = recoveredWrites
      .map(message)
      .find((entry) => entry?.method === 'pty.data')!.params as Record<string, unknown>
    expect(publication.publish('pty-1', { data: 'live' }, false)).toBe(false)

    failedCompletionSettlement!({ ok: false, error: new Error('completion write failed') })

    const replacementWrites: Buffer[] = []
    let replacementCompletionSettlement: ((result: SinkWriteSettlement) => void) | undefined
    const replacementClientId = dispatcher.attachClient(
      (data, settle) => {
        replacementWrites.push(Buffer.from(data))
        if (message(data)?.method === 'pty.recoveryComplete') {
          replacementCompletionSettlement = settle
        } else {
          settle({ ok: true })
        }
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher.feedClient(
      replacementClientId,
      requestFrame(3, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: recoveredGrant.ownerGeneration,
          ownerLease: recoveredGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    const replacementActivation: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      publication.activate(
        'pty-1',
        'incarnation-1',
        {
          clientId: replacementClientId,
          isStale: () => false,
          sessionIdentity: endpointIdentity,
          onResponseSettled: (callback) => replacementActivation.push(callback)
        },
        {
          status: 'checkpoint',
          deliveryToken: String(recoveredData.deliveryToken),
          clientGeneration: Number(recoveredData.clientGeneration),
          ownerGeneration: Number(recoveredData.ownerGeneration),
          ptyIncarnation: 'incarnation-1',
          acceptedSourceEndSu: 8
        }
      )
    ).toMatchObject({ status: 'pending', checkpointSourceEndSu: 8, recoveryEndSu: 8 })
    replacementActivation[0]({ ok: true })
    expect(publication.publish('pty-1', { data: 'live' }, false)).toBe(false)

    replacementCompletionSettlement!({ ok: true })
    expect(publication.publish('pty-1', { data: 'live' }, false)).toBe(true)
    expect(
      replacementWrites.map(message).filter((entry) => entry?.method === 'pty.recoveryComplete')
    ).toHaveLength(1)
    expect(
      replacementWrites.map(message).filter((entry) => entry?.method === 'pty.data')
    ).toHaveLength(1)
    expect(adapter.getDebugSnapshot()).toMatchObject({ deliveryTokens: 1, sourceSu: 4 })
  })
})
