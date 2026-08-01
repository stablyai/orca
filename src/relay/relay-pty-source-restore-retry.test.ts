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

describe('relay PTY source restore retry', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('mints a fresh activation after invalid-checkpoint restore and retry', async () => {
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
    const initialSettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      publication.activate('pty-1', 'incarnation-1', {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => initialSettlements.push(callback)
      })
    ).toBe('opened')
    initialSettlements[0]({ ok: true })
    expect(publication.publish('pty-1', { data: 'old' }, false)).toBe(true)
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
    const restoreSettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      publication.activate(
        'pty-1',
        'incarnation-1',
        {
          clientId: recoveredClientId,
          isStale: () => false,
          sessionIdentity: endpointIdentity,
          onResponseSettled: (callback) => restoreSettlements.push(callback)
        },
        {
          status: 'checkpoint',
          deliveryToken: String(oldData.deliveryToken),
          clientGeneration: Number(oldData.clientGeneration),
          ownerGeneration: Number(oldData.ownerGeneration),
          ptyIncarnation: 'incarnation-1',
          acceptedSourceEndSu: 2
        }
      )
    ).toMatchObject({ status: 'restoreRequired' })
    expect(publication.accepts('pty-1')).toBe(true)
    for (const settle of restoreSettlements) {
      settle({ ok: true })
    }
    expect(publication.accepts('pty-1')).toBe(false)

    const retrySettlements: ((result: SinkWriteSettlement) => void)[] = []
    expect(
      publication.activate('pty-1', 'incarnation-1', {
        clientId: recoveredClientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (callback) => retrySettlements.push(callback)
      })
    ).toBe('opened')
    const sourceActivation = publication.receivingActivation('pty-1', recoveredClientId)
    expect(sourceActivation).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    })
    expect(sourceActivation?.deliveryToken).not.toBe(oldData.deliveryToken)
    retrySettlements[0]({ ok: true })

    expect(publication.publish('pty-1', { data: 'live' }, false)).toBe(true)
    const sourceFrames = recoveredWrites
      .map(message)
      .filter((entry) => entry?.method === 'pty.data')
    expect(sourceFrames).toHaveLength(1)
    expect(sourceFrames[0]?.params).toMatchObject({
      data: 'live',
      deliveryToken: sourceActivation?.deliveryToken
    })
  })
})
