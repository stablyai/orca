// Local Unix socket/named pipe RPC: NDJSON, 1-MB frames, 32 connections, Unix mode 0600 and 30s idle timeout suspended during dispatch.
// Own per-connection cancellation and opt-in long-poll keepalives (design §3.1).
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import type { RpcMessageContext, RpcTransport } from './transport'
import { errorMessage } from '../../../shared/error-message'

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

type RuntimeRpcNativeListener = {
  server: Server
  listened: boolean
  close: Promise<void> | null
  retirement: Promise<void> | null
}

export class UnixSocketTransport implements RpcTransport {
  private readonly endpoint: string
  private readonly kind: 'unix' | 'named-pipe'
  private readonly keepaliveIntervalMs: number
  private server: RuntimeRpcNativeListener | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
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

  start(): Promise<void> {
    if (this.starting) {
      return this.starting
    }
    const stopping = this.stopping
    const operation = Promise.resolve()
      .then(async () => {
        if (stopping) {
          await stopping
        }
        const previous = this.server
        if (previous?.listened && !previous.close) {
          return
        }
        if (previous) {
          previous.retirement = null
          await this.retireNativeServer(previous)
        }
        if (this.kind === 'unix' && existsSync(this.endpoint)) {
          rmSync(this.endpoint, { force: true })
        }
        const server = createServer((socket) => {
          this.handleConnection(socket)
        })
        const owned: RuntimeRpcNativeListener = {
          server,
          listened: false,
          close: null,
          retirement: null
        }
        this.server = owned
        try {
          server.maxConnections = MAX_RUNTIME_RPC_CONNECTIONS
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.endpoint, () => {
              owned.listened = true
              server.off('error', reject)
              resolve()
            })
          })
          if (this.kind === 'unix') {
            chmodSync(this.endpoint, 0o600)
          }
        } catch (error) {
          try {
            await this.retireNativeServer(owned)
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], errorMessage(error), { cause: error })
          }
          throw error
        }
      })
      .finally(() => {
        if (this.starting === operation) {
          this.starting = null
        }
      })
    this.starting = operation
    return operation
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping
    }
    const starting = this.starting
    const operation = Promise.resolve()
      .then(async () => {
        // Initialization reports its cause; failed cleanup remains in the captured retirement.
        await starting?.catch(() => {})
        const owned = this.server
        if (owned) {
          try {
            await this.retireNativeServer(owned)
          } finally {
            owned.retirement = null
          }
        }
      })
      .finally(() => {
        if (this.stopping === operation) {
          this.stopping = null
        }
      })
    this.stopping = operation
    return operation
  }

  private retireNativeServer(owned: RuntimeRpcNativeListener): Promise<void> {
    if (owned.retirement) {
      return owned.retirement
    }
    const operation = Promise.resolve().then(async () => {
      const errors: unknown[] = []
      owned.close ??= new Promise<void>((resolve, reject) => {
        owned.server.close((error) => {
          // Node reports not-running only after its close event, including an unbound acquisition.
          if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      // server.close waits for existing sockets; long-poll keepalives must not hold shutdown open.
      for (const socket of Array.from(this.activeSockets)) {
        try {
          socket.destroy()
        } catch (error) {
          errors.push(error)
        }
      }
      let closed = false
      try {
        await owned.close
        closed = true
      } catch (error) {
        owned.close = null
        errors.push(error)
      }
      if (closed) {
        try {
          if (owned.listened && this.kind === 'unix' && existsSync(this.endpoint)) {
            rmSync(this.endpoint, { force: true })
          }
          if (errors.length === 0 && this.server === owned) {
            this.server = null
          }
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, errorMessage(errors[0]), { cause: errors[0] })
      }
    })
    owned.retirement = operation
    return operation
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
