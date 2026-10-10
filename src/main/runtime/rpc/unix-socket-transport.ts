// Why: this is the original Unix socket / named pipe transport extracted from
// runtime-rpc.ts. It preserves the exact same behavior: newline-delimited JSON,
// 30s idle timeout, 1MB max message, 32 max connections, chmod 0o600 on Unix.
// It also owns the keepalive timer and per-connection abort signal so the
// server-side handler can cancel long-poll dispatches when the client goes
// away. See design doc §3.1. A connection whose first line is a `transport.upgrade`
// request can switch to length-prefixed streaming frames (unix-socket-stream-connection.ts).
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import type { RpcMessageContext, RpcTransport } from './transport'
import type { UnixSocketStreamConnection } from './unix-socket-stream-connection'
import {
  PendingUnixSocketStreamUpgrade,
  isUnixSocketStreamUpgradeRequest,
  type UnixSocketStreamUpgradeHandler
} from './unix-socket-stream-upgrade'

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
  private streamUpgradeHandler: UnixSocketStreamUpgradeHandler | null = null
  private readonly activeSockets = new Set<Socket>()

  constructor({ endpoint, kind, keepaliveIntervalMs }: UnixSocketTransportOptions) {
    this.endpoint = endpoint
    this.kind = kind
    this.keepaliveIntervalMs = keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  // Why: without a handler the upgrade line stays an ordinary request, which answers method_not_found.
  onStreamUpgrade(handler: UnixSocketStreamUpgradeHandler): void {
    this.streamUpgradeHandler = handler
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
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // Why: server.close() stops accepting new connections but waits for
    // existing sockets; long-poll keepalives can otherwise hold shutdown open.
    for (const socket of Array.from(this.activeSockets)) {
      socket.destroy()
    }
    await closePromise
    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket)
    // Why bytes, not setEncoding: an upgraded connection switches to binary frames mid-stream, and a
    // decoder cannot be removed. Splitting on 0x0a is safe because it never occurs inside a UTF-8 sequence.
    let tail: Buffer[] = []
    let retainedBytes = 0
    let oversized = false
    let sawFirstMessage = false
    let pendingUpgrade: PendingUnixSocketStreamUpgrade | null = null
    let stream: UnixSocketStreamConnection | null = null
    // Why: each in-flight dispatch registers its own AbortController here so
    // `socket.on('close')` can abort them all at once. Keeping the set scoped
    // to the connection (rather than a single shared controller) means
    // completing one dispatch does not abort any other dispatch still running
    // on the same socket — future-proofing for a persistent CLI socket that
    // multiplexes sequential requests.
    const inflight = new Set<() => void>()

    socket.setNoDelay(true)
    socket.setTimeout(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.once('close', () => {
      for (const cleanup of inflight) {
        cleanup()
      }
      inflight.clear()
      this.activeSockets.delete(socket)
    })

    socket.on('data', (data: Buffer | string) => {
      const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      if (stream) {
        stream.feed(chunk)
        return
      }
      if (pendingUpgrade) {
        pendingUpgrade.push(chunk)
        return
      }
      if (oversized) {
        return
      }
      retainedBytes += chunk.length
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (retainedBytes > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        oversized = true
        tail = []
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      if (!chunk.includes(0x0a)) {
        tail.push(chunk)
        return
      }
      const buffer = tail.length > 0 ? Buffer.concat([...tail, chunk]) : chunk
      tail = []
      let start = 0
      let newlineIndex = buffer.indexOf(0x0a)
      while (newlineIndex !== -1) {
        const rawMessage = buffer.toString('utf8', start, newlineIndex).trim()
        start = newlineIndex + 1
        if (rawMessage) {
          const upgradeHandler = this.streamUpgradeHandler
          if (!sawFirstMessage && upgradeHandler && isUnixSocketStreamUpgradeRequest(rawMessage)) {
            pendingUpgrade = new PendingUnixSocketStreamUpgrade(
              socket,
              buffer.subarray(start),
              MAX_RUNTIME_RPC_MESSAGE_BYTES,
              (connection) => {
                stream = connection
              }
            )
            upgradeHandler(rawMessage, pendingUpgrade.upgrade)
            return
          }
          sawFirstMessage = true
          this.dispatchMessage(socket, rawMessage, inflight)
        }
        newlineIndex = buffer.indexOf(0x0a, start)
      }
      // Why copy: a short partial tail must not pin the whole read buffer it was sliced from.
      const remainder = buffer.subarray(start)
      tail = remainder.length > 0 ? [Buffer.from(remainder)] : []
      retainedBytes = remainder.length
    })
  }

  // Why: the keepalive timer is opt-in per request via `startKeepalive()`.
  // Short RPCs never call it and pay no timer overhead; only long-poll
  // handlers (e.g. orchestration.check --wait) arm it. See §3.1.
  private dispatchMessage(socket: Socket, rawMessage: string, inflight: Set<() => void>): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    // Why: each dispatch needs its own abort signal and keepalive timer
    // cleanup. Socket close runs every cleanup without touching sibling
    // dispatches that already replied on the same connection.
    const abortController = new AbortController()
    let cleanedUp = false
    const cleanupDispatch = (abort: boolean): void => {
      if (cleanedUp) {
        return
      }
      cleanedUp = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (abort) {
        abortController.abort()
      }
      inflight.delete(abortDispatch)
    }
    const abortDispatch = (): void => cleanupDispatch(true)
    inflight.add(abortDispatch)

    const reply = (response: string): void => {
      if (replied) {
        return
      }
      replied = true
      cleanupDispatch(false)
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
          cleanupDispatch(socket.destroyed || !socket.writable)
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
