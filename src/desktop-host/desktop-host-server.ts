import { createServer, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  DESKTOP_HOST_CAPABILITIES,
  DESKTOP_HOST_KIND,
  isDesktopIpcClientMessage,
  type DesktopHostInfo,
  type DesktopIpcServerMessage
} from '../shared/desktop-host-protocol'
import { E2EEChannel } from '../main/runtime/rpc/e2ee-channel'
import {
  formatDesktopHostHttpUrl,
  formatDesktopHostIpcUrl,
  type DesktopHostListenConfig
} from './desktop-host-config'
import { createDesktopHostPairingMaterial } from './desktop-host-pairing'
import { DesktopHostPtyBroker } from './desktop-host-pty'
import { invokeDesktopHostChannel, sendDesktopHostChannel } from './desktop-host-rpc'

export type DesktopHostHandle = {
  info: DesktopHostInfo
  close(): Promise<void>
}

type EncryptedRpcRequest = {
  id?: unknown
  method?: unknown
  params?: unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function sendIpc(socket: WebSocket, message: DesktopIpcServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

export async function startDesktopHostServer(
  config: DesktopHostListenConfig
): Promise<DesktopHostHandle> {
  const pairing = createDesktopHostPairingMaterial(`ws://${config.host}:${config.port}`)
  const info: DesktopHostInfo = {
    host: DESKTOP_HOST_KIND,
    runtimeId: pairing.runtimeId,
    httpUrl: formatDesktopHostHttpUrl(config),
    ipcUrl: formatDesktopHostIpcUrl(config),
    pairing: pairing.offer,
    pairingUrl: pairing.pairingUrl,
    platform: process.platform,
    osRelease: process.platform,
    capabilities: [...DESKTOP_HOST_CAPABILITIES]
  }
  const pty = new DesktopHostPtyBroker()
  const rpcContext = { runtimeId: pairing.runtimeId, pty }
  const httpServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', info.httpUrl)
    if (req.method === 'GET' && url.pathname === '/desktop/health') {
      sendJson(res, 200, { ok: true, host: DESKTOP_HOST_KIND, runtimeId: pairing.runtimeId })
      return
    }
    if (req.method === 'GET' && (url.pathname === '/desktop/host' || url.pathname === '/')) {
      sendJson(res, 200, info)
      return
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: 'not_found', message: 'Unknown desktop host route' }
    })
  })
  const sockets = new Set<WebSocket>()
  const ipcServer = new WebSocketServer({ noServer: true })
  const pairingServer = new WebSocketServer({ noServer: true })

  const emitIpcEvent = (channel: string, args: unknown): void => {
    for (const socket of sockets) {
      sendIpc(socket, { type: 'event', channel, args })
    }
  }
  pty.on('data', (payload) => emitIpcEvent('pty:data', payload))
  pty.on('exit', (payload) => emitIpcEvent('pty:exit', payload))

  ipcServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!isDesktopIpcClientMessage(parsed)) {
        return
      }
      try {
        if (parsed.type === 'send') {
          sendDesktopHostChannel(rpcContext, parsed.channel, parsed.args)
          return
        }
        const result = invokeDesktopHostChannel(rpcContext, parsed.channel, parsed.args)
        sendIpc(socket, { type: 'result', id: parsed.id, ok: true, result })
      } catch (error) {
        if (parsed.type !== 'invoke') {
          return
        }
        const err = error as { code?: string; message?: string }
        sendIpc(socket, {
          type: 'result',
          id: parsed.id,
          ok: false,
          error: {
            code: err.code ?? 'host_error',
            message: err.message ?? 'Desktop host request failed'
          }
        })
      }
    })
  })

  pairingServer.on('connection', (socket) => {
    const channel = new E2EEChannel(socket, {
      serverSecretKey: pairing.secretKey,
      resolveAuthenticatedDevice: (token) =>
        token === pairing.deviceToken
          ? { deviceId: pairing.runtimeId, deviceToken: pairing.deviceToken, scope: 'runtime' }
          : null,
      onReady: () => {},
      onError: (code, reason) => {
        socket.close(code, reason)
      }
    })
    channel.onMessage((plaintext, encryptedReply) => {
      let request: EncryptedRpcRequest
      try {
        request = JSON.parse(plaintext) as EncryptedRpcRequest
      } catch {
        return
      }
      const id = typeof request.id === 'string' ? request.id : 'unknown'
      const method = typeof request.method === 'string' ? request.method : ''
      try {
        const result = invokeDesktopHostChannel(rpcContext, method, request.params)
        encryptedReply(
          JSON.stringify({
            id,
            ok: true,
            result,
            _meta: { runtimeId: pairing.runtimeId }
          })
        )
      } catch (error) {
        const err = error as { code?: string; message?: string }
        encryptedReply(
          JSON.stringify({
            id,
            ok: false,
            error: {
              code: err.code ?? 'host_error',
              message: err.message ?? 'Desktop host request failed'
            },
            _meta: { runtimeId: pairing.runtimeId }
          })
        )
      }
    })
    socket.on('message', (raw) => {
      channel.handleRawMessage(typeof raw === 'string' ? raw : new Uint8Array(raw as Buffer))
    })
    socket.on('close', () => channel.destroy())
  })

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', info.httpUrl)
    if (url.pathname === '/desktop/ipc') {
      ipcServer.handleUpgrade(request, socket, head, (ws) =>
        ipcServer.emit('connection', ws, request)
      )
      return
    }
    pairingServer.handleUpgrade(request, socket, head, (ws) =>
      pairingServer.emit('connection', ws, request)
    )
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  return {
    info,
    async close() {
      await pty.dispose()
      await new Promise<void>((resolve) => ipcServer.close(() => resolve()))
      await new Promise<void>((resolve) => pairingServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}
