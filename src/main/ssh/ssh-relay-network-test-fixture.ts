import { createServer, type Socket } from 'node:net'
import { afterEach, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshRelayNetworkTunnelTransport } from './ssh-relay-network-tunnel-transport'
import { RelayDispatcher } from '../../relay/dispatcher'
import { RelayNetworkTunnelRegistry } from '../../relay/relay-network-tunnel-registry'
import { registerRelayNetworkTunnels } from '../../relay/relay-network-tunnel-registration'

export const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose()
  }
})

export function fixture(supportsWriteSettlement = true) {
  let receive: (bytes: Buffer) => void = () => {
    throw new Error('not attached')
  }
  const sentMethods: string[] = []
  const dispatcher = new RelayDispatcher(
    (bytes, settle) => {
      receive(bytes)
      settle({ ok: true })
      return true
    },
    { supportsWriteCallback: true },
    {
      principal: 'owner',
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  )
  const mux = new SshChannelMultiplexer({
    sourceChannel: {},
    supportsWriteSettlement,
    write: (bytes, settle) => {
      sentMethods.push(JSON.parse(bytes.subarray(13).toString()).method)
      dispatcher.feed(bytes)
      settle?.({ ok: true })
      return true
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: vi.fn()
  })
  const owner = { ownerGeneration: 1, ownerLease: 'lease' }
  const registry = new RelayNetworkTunnelRegistry({
    dispatcher,
    runtimeIncarnation: 'runtime',
    ownsEndpoint: () => true,
    owners: { activeSessionOwner: () => owner, assertOwnerPublicationSettled: () => {} }
  })
  const status = registerRelayNetworkTunnels(dispatcher, registry, 'runtime', () => true)
  const readStatus = vi.fn(() => status())
  dispatcher.onRequest('relay.status', async () => readStatus())
  cleanup.push(() => {
    mux.dispose()
    registry.dispose()
    dispatcher.dispose()
  })
  const assertCurrent = vi.fn<() => void>()
  const create = () => SshRelayNetworkTunnelTransport.create({ mux, owner, assertCurrent })
  return { mux, dispatcher, registry, owner, readStatus, create, assertCurrent, sentMethods }
}

export async function echoServer() {
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('data', (data) => socket.write(data))
    socket.on('end', () => socket.end())
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}
