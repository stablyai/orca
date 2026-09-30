import { afterEach, expect, it } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { boundedPtyRecoveryEnd } from './relay-pty-source-activation'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

type Frame = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

function decode(buffer: Buffer): Frame | null {
  return buffer[0] === MessageType.Regular
    ? JSON.parse(buffer.subarray(13, 13 + buffer.readUInt32BE(9)).toString('utf8'))
    : null
}

const flushRequests = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
let dispatcher: RelayDispatcher | undefined

afterEach(() => dispatcher?.dispose())

it.each([0, 4])(
  'drains a retained tail larger than the window from checkpoint %i',
  async (checkpoint) => {
    const original: Frame[] = []
    dispatcher = new RelayDispatcher(
      (data, settled) => {
        const frame = decode(data)
        if (frame) {
          original.push(frame)
        }
        settled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    const mux = dispatcher
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(mux, 'build', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(mux, adapter, () => {})
    const open = (clientId: number, id: number, resume?: Record<string, unknown>): void => {
      mux.feedClient(
        clientId,
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            id,
            method: 'pty.openClient',
            params: {
              protocolVersion: 1,
              clientInstanceId: 'client',
              requestedRole: 'session-owner',
              resume,
              capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
            }
          },
          id,
          0
        )
      )
    }
    open(1, 1)
    await flushRequests()
    publication.activate('pty', 'incarnation', {
      clientId: 1,
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (settle) => queueMicrotask(() => settle({ ok: true }))
    })
    await flushRequests()
    expect(publication.publish('pty', { data: 'abcdefghijkl' }, false)).toBe(true)
    const oldFrame = original.find((frame) => frame.method === 'pty.data')!.params!
    const grant = original.find((frame) => frame.id === 1)!.result!
    mux.invalidateClient()
    const replacement: Frame[] = []
    const clientId = mux.attachClient(
      (data, settled) => {
        const frame = decode(data)
        if (frame) {
          replacement.push(frame)
        }
        settled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    open(clientId, 2, { ownerGeneration: grant.ownerGeneration, ownerLease: grant.ownerLease })
    await flushRequests()
    const recovery = publication.activate(
      'pty',
      'incarnation',
      {
        clientId,
        isStale: () => false,
        sessionIdentity: endpointIdentity,
        onResponseSettled: (settle) => queueMicrotask(() => settle({ ok: true }))
      },
      {
        status: 'checkpoint',
        clientGeneration: Number(oldFrame.clientGeneration),
        ownerGeneration: Number(oldFrame.ownerGeneration),
        deliveryToken: String(oldFrame.deliveryToken),
        ptyIncarnation: 'incarnation',
        acceptedSourceEndSu: checkpoint
      }
    )
    // The fence lands on the checkpoint itself: the tail drains live rather than behind it.
    expect(recovery).toMatchObject({
      status: 'pending',
      checkpointSourceEndSu: checkpoint,
      recoveryEndSu: checkpoint
    })
    await flushRequests()
    // The receiver cannot ACK quarantined data until this fence arrives.
    expect(replacement.filter((frame) => frame.method === 'pty.recoveryComplete')).toHaveLength(1)
    let accepted = checkpoint
    let output = ''
    for (let turn = 0; accepted < 12 && turn < 4; turn++) {
      const frames = replacement.filter(
        (frame) => frame.method === 'pty.data' && Number(frame.params!.sourceEndSu) > accepted
      )
      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        const params = frame.params!
        expect(Number(params.sourceEndSu) - Number(params.sourceLengthSu)).toBe(accepted)
        accepted = Number(params.sourceEndSu)
        output += String(params.data)
      }
      expect(publication.getDebugSnapshot().outstandingSourceUnits).toBeLessThanOrEqual(4)
      const params = frames.at(-1)!.params!
      mux.feedClient(
        clientId,
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            method: 'pty.ackData',
            params: {
              acknowledgements: [
                {
                  id: 'pty',
                  clientGeneration: params.clientGeneration,
                  ownerGeneration: params.ownerGeneration,
                  deliveryToken: params.deliveryToken,
                  creditedEndSu: accepted
                }
              ]
            }
          },
          3 + turn,
          0
        )
      )
      await flushRequests()
    }
    expect(accepted).toBe(12)
    expect(output).toBe('abcdefghijkl'.slice(checkpoint))
    expect(publication.getDebugSnapshot().outstandingSourceUnits).toBe(0)
  }
)

it('fences at the checkpoint only once the tail outgrows the window', () => {
  const tail = (receivedEndSu: number) => ({ receivedEndSu, creditedEndSu: 4, windowSu: 4 })
  // Exactly one window is still deliverable without credit, so it keeps the ordinary fence.
  expect(boundedPtyRecoveryEnd(tail(8))).toBe(8)
  expect(boundedPtyRecoveryEnd(tail(9))).toBe(4)
})
