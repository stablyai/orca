import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { CodexUnixAppServerClient } from './codex-unix-app-server-client'

const roots: string[] = []
const servers: (HttpServer | NetServer)[] = []
const webSocketServers: WebSocketServer[] = []
const connections: Socket[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.destroy()
  }
  for (const webSocketServer of webSocketServers.splice(0)) {
    for (const socket of webSocketServer.clients) {
      socket.terminate()
    }
    webSocketServer.close()
  }
  await Promise.allSettled(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe.skipIf(process.platform === 'win32')('CodexUnixAppServerClient', () => {
  it('terminates sockets after connection errors and timeouts', async () => {
    const terminate = vi.spyOn(WebSocket.prototype, 'terminate')
    const missingRoot = createRoot()

    await expect(
      CodexUnixAppServerClient.connect(join(missingRoot, 'missing.sock'), 50)
    ).rejects.toBeInstanceOf(Error)

    const stalledPath = join(createRoot(), 'stalled.sock')
    const stalled = createNetServer()
    stalled.on('connection', (socket) => connections.push(socket))
    servers.push(stalled)
    await new Promise<void>((resolve) => stalled.listen(stalledPath, resolve))
    await expect(CodexUnixAppServerClient.connect(stalledPath, 20)).rejects.toThrow('timed out')
    expect(terminate).toHaveBeenCalledTimes(2)
  })

  it('terminates an initialized socket when initialize fails', async () => {
    const terminate = vi.spyOn(WebSocket.prototype, 'terminate')
    const fixture = await createRpcServer((socket, message) => {
      socket.send(
        JSON.stringify({ id: message.id, error: { code: -32603, message: 'initialize failed' } })
      )
    })

    await expect(CodexUnixAppServerClient.connect(fixture.socketPath)).rejects.toThrow(
      'initialize failed'
    )
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('preserves RPC error metadata and isolates notification listeners', async () => {
    let connected: WebSocket | undefined
    const fixture = await createRpcServer((socket, message) => {
      connected = socket
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
      } else {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32602, message: 'thread missing', data: { threadId: 'missing' } }
          })
        )
      }
    })
    const client = await CodexUnixAppServerClient.connect(fixture.socketPath)
    const delivered = vi.fn()
    client.onNotification(() => {
      throw new Error('listener failed')
    })
    client.onNotification(delivered)

    await expect(client.request('thread/read')).rejects.toMatchObject({
      rpcCode: -32602,
      rpcData: { threadId: 'missing' }
    })
    connected?.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } }))
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce())
    client.close()
  })
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-client-'))
  roots.push(root)
  return root
}

async function createRpcServer(
  onRequest: (socket: WebSocket, message: { id: number; method: string }) => void
): Promise<{ socketPath: string }> {
  const socketPath = join(createRoot(), 'rpc.sock')
  const server = createHttpServer()
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  servers.push(server)
  webSocketServers.push(webSocketServer)
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      webSocketServer.emit('connection', webSocket, request)
    )
  })
  webSocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; method: string }
      if (message.id !== undefined) {
        onRequest(socket, { id: message.id, method: message.method })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { socketPath }
}
