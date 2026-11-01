// Local Unix socket/named pipe RPC: NDJSON, 1-MB frames, 32 connections, Unix mode 0600 and 30s idle timeout suspended during dispatch.
// Own per-connection cancellation and opt-in long-poll keepalives (design §3.1).
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import type { RpcMessageContext, RpcTransport } from './transport'

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
const MAX_RUNTIME_RPC_CONNECTIONS = 32
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000

export type UnixSocketTransportOptions = {
  endpoint: string
  kind: 'unix' | 'named-pipe'
  // Keepalive writes reset host and supporting-client idle timers; tests shorten the 10s interval.
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
  private readonly activeSockets = new Set<Socket>()

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
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // server.close waits for existing sockets; long-poll keepalives must not hold shutdown open.
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
    let buffer = ''
    let retainedBytes = 0
    let oversized = false
    // One controller per in-flight dispatch: close aborts all, but completing one must not cancel siblings.
    const inflight = new Set<() => void>()
    // Byte silence does not mean death during slow dispatch; suspend idle reap until pending work completes. Local kernel close detects dead peers.
    const rearmIdleTimer = (): void => {
      if (!socket.destroyed) {
        socket.setTimeout(inflight.size > 0 ? 0 : RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS)
      }
    }

    socket.setEncoding('utf8')
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
    socket.on('data', (chunk: string) => {
      if (oversized) {
        return
      }
      buffer += chunk
      // setEncoding('utf8') keeps split codepoints intact, so chunk byte lengths add exactly.
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      // Bound oversized frames before they grow buffers and stall Electron main.
      if (retainedBytes > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        oversized = true
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      if (!chunk.includes('\n')) {
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          this.dispatchMessage(socket, rawMessage, inflight, rearmIdleTimer)
        }
        newlineIndex = buffer.indexOf('\n')
      }
      retainedBytes = Buffer.byteLength(buffer, 'utf8')
    })
  }

  // Only opted-in long polls arm keepalives; short RPCs pay no timer cost (design §3.1).
  private dispatchMessage(
    socket: Socket,
    rawMessage: string,
    inflight: Set<() => void>,
    rearmIdleTimer: () => void
  ): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    // Each dispatch owns abort/timer cleanup; socket close runs all without affecting already-completed siblings.
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
      rearmIdleTimer()
    }
    const abortDispatch = (): void => cleanupDispatch(true)
    inflight.add(abortDispatch)
    rearmIdleTimer()

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
      // Keepalive alone must not hold the process open.
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
