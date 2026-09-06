// Loopback client openers for the package-download measurement harness: the real direct
// WebSocket client and the real cloud-relay session, each with an injectable per-hop delay.
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { connect as connectDirectRpcClient, type RpcClient } from '../src/transport/rpc-client'
import { connectMobileRelayRpcSession } from '../src/transport/mobile-relay-rpc-session'
import type { MobileRelayEndpoint } from '../../src/shared/mobile-relay-credential-contract'
import {
  MobileSocketWiring,
  type MobileSocketTransport
} from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { CloudRelayTransport } from '../../src/main/runtime/rpc/relay-transport'

export type Teardown = (() => Promise<void> | void)[]

export async function openRelayClient(args: {
  wiring: MobileSocketWiring
  relayEndpoint: MobileRelayEndpoint
  relayHostId: string
  relayDeviceId: string
  deviceToken: string
  desktopPublicKeyB64: string
  oneWayDelayMs: number
  teardown: Teardown
  countInbound: (bytes: number) => void
}): Promise<RpcClient> {
  const relayServer = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const port = await listen(relayServer, args.teardown)

  let hostSocket: WebSocket | null = null
  let phoneSocket: WebSocket | null = null
  const splice = (): void => {
    if (!hostSocket || !phoneSocket) {
      return
    }
    const host = hostSocket
    const phone = phoneSocket
    host.on('message', (raw, isBinary) => {
      args.countInbound(rawByteLength(raw))
      forward(phone, raw, isBinary, args.oneWayDelayMs)
    })
    phone.on('message', (raw, isBinary) => forward(host, raw, isBinary, args.oneWayDelayMs))
    phone.send(
      JSON.stringify({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'resume',
        leaseExpiresAt: Date.now() + 900_000,
        acceptedCredentialVersion: 3,
        acceptedAs: 'current',
        resumeExpiresAt: Date.now() + 900_000
      })
    )
  }
  relayServer.on('connection', (socket, request) => {
    socket.once('message', () => {
      if (request.url === '/v1/host/data/connection-1') {
        hostSocket = socket
      } else {
        phoneSocket = socket
      }
      splice()
    })
  })

  const transport = new CloudRelayTransport({
    cellUrl: `http://127.0.0.1:${port}`,
    relayHostId: args.relayHostId,
    generation: 1
  })
  args.teardown.push(() => transport.stop())
  args.wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
  await transport.start()
  await transport.openConnection({
    connId: 'connection-1',
    connTicket: 'A'.repeat(43),
    kind: 'resume',
    relayDeviceId: args.relayDeviceId,
    attachDeadlineMs: 15_000
  })

  const session = connectMobileRelayRpcSession({
    relay: args.relayEndpoint,
    resumeToken: 'B'.repeat(43),
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'measure-confirm',
    deviceToken: args.deviceToken,
    desktopPublicKeyB64: args.desktopPublicKeyB64,
    requestTimeoutMs: 180_000,
    createSocket: () =>
      new WebSocketClient(`ws://127.0.0.1:${port}/v1/connect/${args.relayHostId}`, {
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024
      }) as unknown as globalThis.WebSocket
  })
  args.teardown.push(() => session.close())
  await waitFor(() => session.getState() === 'connected', 30_000, 'relay session connect')
  return session
}

export async function openDirectClient(args: {
  wiring: MobileSocketWiring
  deviceToken: string
  desktopPublicKeyB64: string
  oneWayDelayMs: number
  teardown: Teardown
  countInbound: (bytes: number) => void
}): Promise<RpcClient> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const port = await listen(server, args.teardown)
  args.wiring.attachTransport(
    createDirectLoopbackTransport(server, args.oneWayDelayMs, args.countInbound)
  )
  const client = connectDirectRpcClient(
    `ws://127.0.0.1:${port}`,
    args.deviceToken,
    args.desktopPublicKeyB64
  )
  args.teardown.push(() => client.close())
  await waitFor(() => client.getState() === 'connected', 30_000, 'direct client connect')
  return client
}

function createDirectLoopbackTransport(
  server: WebSocketServer,
  oneWayDelayMs: number,
  countInbound: (bytes: number) => void
): MobileSocketTransport {
  type MessageHandler = (
    message: string | Uint8Array,
    reply: (response: string) => void,
    ws: WebSocket
  ) => void
  const messageHandlers: MessageHandler[] = []
  const closeHandlers: ((clientId: string | null, ws: WebSocket, other: boolean) => void)[] = []
  const clientIds = new Map<WebSocket, string>()
  server.on('connection', (socket) => {
    // Why: the desktop replies through E2EEChannel's own ws.send, so the outbound hop is
    // delayed by wrapping send rather than by a forwarding splice like the relay path has.
    delaySocketSend(socket, oneWayDelayMs, countInbound)
    socket.on('message', (raw, isBinary) => {
      const message = isBinary ? toBytes(raw) : raw.toString('utf8')
      after(oneWayDelayMs, () => {
        for (const handler of messageHandlers) {
          handler(message, () => {}, socket)
        }
      })
    })
    socket.on('close', () => {
      const clientId = clientIds.get(socket) ?? null
      clientIds.delete(socket)
      for (const handler of closeHandlers) {
        handler(clientId, socket, false)
      }
    })
  })
  return {
    onMessage: (handler) => messageHandlers.push(handler),
    onConnectionClose: (handler) => closeHandlers.push(handler),
    setClientId: (ws, clientId) => clientIds.set(ws, clientId),
    terminateClientConnections: (clientId) => {
      let terminated = 0
      for (const [socket, id] of clientIds) {
        if (id === clientId) {
          socket.terminate()
          terminated += 1
        }
      }
      return terminated
    }
  }
}

function delaySocketSend(
  socket: WebSocket,
  oneWayDelayMs: number,
  countInbound: (bytes: number) => void
): void {
  const send = socket.send.bind(socket)
  socket.send = ((data: string | Uint8Array, ...rest: unknown[]) => {
    countInbound(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength)
    after(oneWayDelayMs, () => {
      if (socket.readyState === socket.OPEN) {
        ;(send as (...values: unknown[]) => void)(data, ...rest)
      }
    })
  }) as typeof socket.send
}

function forward(socket: WebSocket, raw: RawData, isBinary: boolean, oneWayDelayMs: number): void {
  after(oneWayDelayMs, () => {
    if (socket.readyState === socket.OPEN) {
      socket.send(raw, { binary: isBinary })
    }
  })
}

function after(delayMs: number, run: () => void): void {
  if (delayMs <= 0) {
    queueMicrotask(run)
    return
  }
  setTimeout(run, delayMs)
}

async function listen(server: WebSocketServer, teardown: Teardown): Promise<number> {
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) {
          socket.terminate()
        }
        server.close(() => resolve())
      })
  )
  return address.port
}

function rawByteLength(raw: RawData): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw) : toBytes(raw).byteLength
}

function toBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw)
  }
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as Buffer)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}
