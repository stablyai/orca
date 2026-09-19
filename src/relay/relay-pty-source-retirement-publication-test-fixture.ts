import { expect } from 'vitest'
import { RelayDispatcher, type RelayClientSessionIdentity } from './dispatcher'
import { encodeJsonRpcFrame, FrameDecoder } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpoint: RelayClientSessionIdentity = {
  principal: 'endpoint',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

export async function createSourceRetirementPublicationFixture() {
  const writes: Buffer[] = []
  const dispatcher = new RelayDispatcher(
    (data, settle) => {
      writes.push(Buffer.from(data))
      settle({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    endpoint
  )
  let publication: RelayPtySourcePublication
  const session = new SshPtyConsumerSessionAdapter(dispatcher, 'build', undefined, (id) =>
    publication.onCreditAvailable(id)
  )
  publication = new RelayPtySourcePublication(dispatcher, session, () => {})
  dispatcher.feed(
    encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'pty.openClient',
        params: {
          protocolVersion: 1,
          clientInstanceId: 'client',
          requestedRole: 'session-owner',
          capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 256 } }
        }
      },
      1,
      0
    )
  )
  await new Promise((resolve) => setImmediate(resolve))
  const activate = (id: string) => {
    let settled: ((result: { ok: true }) => void) | undefined
    expect(
      publication.activate(id, `incarnation-${id}`, {
        clientId: 1,
        isStale: () => false,
        sessionIdentity: endpoint,
        onResponseSettled: (callback) => {
          settled = callback
        }
      })
    ).toBe('opened')
    settled!({ ok: true })
  }
  activate('source')
  activate('other')
  const source = publication.ownershipTransfer.resolve('source')!
  const prepare = () => publication.prepareOwnershipTransferRetirement(source, 1)
  let requestId = 10
  const request = async (method: string, params: Record<string, unknown>, clientId = 1) => {
    const id = ++requestId
    const start = writes.length
    dispatcher.feedClient(
      clientId,
      encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
    )
    await new Promise((resolve) => setImmediate(resolve))
    let response: Record<string, unknown> | undefined
    const decoder = new FrameDecoder((frame) => {
      const message = JSON.parse(frame.payload.toString('utf8'))
      if (message.id === id) {
        response = message
      }
    })
    for (const frame of writes.slice(start)) {
      decoder.feed(frame)
    }
    expect(response).toBeDefined()
    return response!
  }
  const acknowledge = async (id: string, creditedEndSu: number) => {
    const activation = publication.receivingActivation(id, 1)!
    dispatcher.feed(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          method: 'pty.ackData',
          params: {
            acknowledgements: [
              {
                id,
                clientGeneration: activation.clientGeneration,
                ownerGeneration: activation.ownerGeneration,
                deliveryToken: activation.deliveryToken,
                creditedEndSu
              }
            ]
          }
        },
        2,
        0
      )
    )
    await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    publication,
    session,
    writes,
    activate,
    prepare,
    request,
    acknowledge,
    source,
    resumeOwner: async () => {
      const clientId = dispatcher.attachClient(
        (data, settle) => {
          writes.push(Buffer.from(data))
          settle({ ok: true })
          return true
        },
        { supportsWriteCallback: true },
        endpoint
      )
      const response = await request(
        'pty.openClient',
        {
          protocolVersion: 1,
          clientInstanceId: 'client',
          requestedRole: 'session-owner',
          resume: {
            ownerGeneration: source.sourceOwnerGeneration,
            ownerLease: source.ownerLease
          },
          capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 256 } }
        },
        clientId
      )
      return { clientId, response }
    },
    detachOwner: () => dispatcher.invalidateClient('peer-closed'),
    dispose: () => {
      publication.dispose()
      dispatcher.dispose()
    }
  }
}
