// Why: this is the original Unix socket / named pipe transport extracted from
// runtime-rpc.ts. It preserves the exact same behavior: newline-delimited JSON,
// 30s idle timeout, 1MB max message, 32 max connections, chmod 0o600 on Unix.
// It also owns the keepalive timer and per-connection abort signal so the
// server-side handler can cancel long-poll dispatches when the client goes
// away. See design doc §3.1.
import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, rmSync } from 'fs'
import type { RpcMessageContext, RpcTransport } from './transport'

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
const MAX_RUNTIME_RPC_CONNECTIONS = 32
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000

export type UnixSocketTransportOptions = {
  endpoint: string
  kind: 'unix' | 'named-pipe'
  // Why: how often to write `{"_keepalive":true}\n` frames while a dispatch
  // is pending. Each write resets both the server-side idle timer and, once
  // the client honours them, the client-side idle timer. Tests override this
  // to avoid waiting 10 s for a frame.
  keepaliveIntervalMs?: number
}

type MessageHandler = (
  msg: string,
  reply: (response: string) => void,
  context?: RpcMessageContext
) => void

export class UnixSocketTransport implements RpcTransport {
  private readonly endpoint: string
  private readonly kind: 'unix' | 'named-pipe'
  private readonly keepaliveIntervalMs: number
  private server: Server | null = null
  private messageHandler: MessageHandler | null = null

  constructor({ endpoint, kind, keepaliveIntervalMs }: UnixSocketTransportOptions) {
    this.endpoint = endpoint
    this.kind = kind
    this.keepaliveIntervalMs = keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = MAX_RUNTIME_RPC_CONNECTIONS

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })

    if (this.kind === 'unix') {
      chmodSync(this.endpoint, 0o600)
    }

    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''
    let oversized = false
    // Why: each in-flight dispatch registers its own AbortController here so
    // `socket.on('close')` can abort them all at once. Keeping the set scoped
    // to the connection (rather than a single shared controller) means
    // completing one dispatch does not abort any other dispatch still running
    // on the same socket — future-proofing for a persistent CLI socket that
    // multiplexes sequential requests.
    const inflight = new Set<AbortController>()

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      for (const ctrl of inflight) {
        ctrl.abort()
      }
      inflight.clear()
    })
    socket.on('data', (chunk: string) => {
      if (oversized) {
        return
      }
      buffer += chunk
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        oversized = true
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          this.dispatchMessage(socket, rawMessage, inflight)
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
  }

  // Why: the keepalive timer is opt-in per request via `startKeepalive()`.
  // Short RPCs never call it and pay no timer overhead; only long-poll
  // handlers (e.g. orchestration.check --wait) arm it. See §3.1.
  private dispatchMessage(
    socket: Socket,
    rawMessage: string,
    inflight: Set<AbortController>
  ): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    // Why: per-dispatch AbortController so completing one request does not
    // abort any sibling request running on the same connection. The
    // connection-level `socket.on('close')` iterates `inflight` to cancel all
    // outstanding dispatches at once.
    const abortController = new AbortController()
    inflight.add(abortController)

    const reply = (response: string): void => {
      if (replied) {
        return
      }
      replied = true
      inflight.delete(abortController)
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
      }
      if (!socket.destroyed && socket.writable) {
        socket.write(`${response}\n`)
      }
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer || replied) {
        return
      }
      keepaliveTimer = setInterval(() => {
        if (replied || socket.destroyed || !socket.writable) {
          return
        }
        socket.write('{"_keepalive":true}\n')
      }, this.keepaliveIntervalMs)
      // Why: don't hold the process open solely on the keepalive interval.
      if (typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref()
      }
    }

    this.messageHandler?.(rawMessage, reply, {
      signal: abortController.signal,
      startKeepalive
    })
  }
}
