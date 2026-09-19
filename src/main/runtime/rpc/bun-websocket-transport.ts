import type { WebSocket } from 'ws'
import type { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'
import {
  adaptBunSocket,
  type BunServerWebSocket,
  type BunSocketAdapter
} from './bun-websocket-adapter'
import {
  WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES,
  WEBSOCKET_TRANSPORT_MAX_CONNECTIONS,
  WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES
} from './websocket-transport-limits'

type BunServer = {
  hostname: string
  port: number
  upgrade(request: Request, options?: { data?: unknown }): boolean
  stop(options?: { closeActiveConnections?: boolean } | boolean): void | Promise<void>
}

type BunRuntime = {
  serve(options: {
    hostname: string
    port: number
    idleTimeout: number
    maxRequestBodySize: number
    fetch(request: Request, server: BunServer): Response | undefined
    websocket: {
      data: Record<string, never>
      maxPayloadLength: number
      backpressureLimit: number
      closeOnBackpressureLimit: boolean
      open(socket: BunServerWebSocket): void
      message(socket: BunServerWebSocket, message: string | ArrayBuffer | Uint8Array): void
      pong(socket: BunServerWebSocket): void
      close(socket: BunServerWebSocket): void
      error(socket: BunServerWebSocket, error: unknown): void
    }
  }): BunServer
}

type BunGlobal = typeof globalThis & { Bun?: BunRuntime }

type BunWebSocketTransportCallbacks = {
  messageHandler: (
    message: string | Uint8Array<ArrayBufferLike>,
    reply: (response: string) => void,
    ws: WebSocket
  ) => void
  connectionCloseHandler: (
    clientId: string | null,
    ws: WebSocket,
    hasOtherConnections: boolean
  ) => void
}

const getBunRuntime = (): BunRuntime | undefined => (globalThis as BunGlobal).Bun

export function canUseBunWebSocketTransport(): boolean {
  return typeof getBunRuntime()?.serve === 'function'
}

export class BunWebSocketTransport {
  private server: BunServer | null = null
  private pendingUpgrades = 0
  private readonly clients = new Set<BunServerWebSocket>()
  private readonly adapters = new WeakMap<BunServerWebSocket, BunSocketAdapter>()
  private readonly adapterClients = new Set<BunSocketAdapter>()
  private readonly clientIds = new Map<BunSocketAdapter, string>()
  private readonly preAuthTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly options: {
      preAuthTimeoutMs: number
      heartbeat: RemoteRuntimeServerHeartbeat
      callbacks: BunWebSocketTransportCallbacks
    }
  ) {}

  get port(): number {
    if (!this.server) {
      throw new Error('Bun WebSocket transport is not started')
    }
    return this.server.port
  }

  start(): void {
    if (this.server) {
      return
    }
    const runtime = getBunRuntime()
    if (!runtime) {
      throw new Error('Bun runtime is unavailable')
    }
    this.server = runtime.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 10,
      maxRequestBodySize: WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES,
      fetch: (request, server) => {
        if (!this.server) {
          return new Response('WebSocket transport is stopping', { status: 503 })
        }
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Orca internal WebSocket endpoint', { status: 426 })
        }
        if (this.clients.size + this.pendingUpgrades >= WEBSOCKET_TRANSPORT_MAX_CONNECTIONS) {
          return new Response('Maximum connections reached', { status: 503 })
        }
        this.pendingUpgrades += 1
        let upgraded = false
        try {
          upgraded = server.upgrade(request)
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
        } finally {
          // A successful upgrade consumes this reservation in handleOpen. Failed upgrades do not.
          if (!upgraded) {
            this.pendingUpgrades = Math.max(0, this.pendingUpgrades - 1)
          }
        }
      },
      websocket: {
        data: {} as Record<string, never>,
        maxPayloadLength: WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES,
        backpressureLimit: WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES,
        closeOnBackpressureLimit: true,
        open: (socket) => this.handleOpen(socket),
        message: (socket, message) => this.handleMessage(socket, message),
        pong: (socket) => {
          const adapter = this.adapters.get(socket)
          if (adapter) {
            this.options.heartbeat.noteAlive(adapter)
          }
        },
        error: (socket, error) => this.handleError(socket, error),
        close: (socket) => this.handleClose(socket)
      }
    })
  }

  setClientId(ws: WebSocket, clientId: string): void {
    const socket = this.findSocket(ws)
    if (socket) {
      this.clientIds.set(socket, clientId)
      this.clearPreAuthTimer(socket)
    }
  }

  terminateClientConnections(clientId: string): number {
    let terminated = 0
    for (const [socket, candidate] of this.clientIds) {
      if (candidate === clientId) {
        socket.terminate()
        terminated += 1
      }
    }
    return terminated
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.pendingUpgrades = 0
    if (!server) {
      return
    }
    this.options.heartbeat.stop()
    for (const socket of this.clients) {
      socket.terminate()
    }
    try {
      await server.stop({ closeActiveConnections: true })
    } finally {
      for (const socket of Array.from(this.clients)) {
        this.handleClose(socket)
      }
    }
  }

  private handleOpen(socket: BunServerWebSocket): void {
    if (this.pendingUpgrades > 0) {
      this.pendingUpgrades -= 1
    }
    if (!this.server) {
      socket.terminate()
      return
    }
    if (this.clients.size >= WEBSOCKET_TRANSPORT_MAX_CONNECTIONS) {
      socket.close(1013, 'Maximum connections reached')
      const timer = setTimeout(() => socket.terminate(), 1_000)
      timer.unref?.()
      return
    }
    const adapter = adaptBunSocket(socket)
    this.clients.add(socket)
    this.adapters.set(socket, adapter)
    this.adapterClients.add(adapter)
    const timer = setTimeout(() => {
      if (!this.clientIds.has(adapter)) {
        socket.terminate()
      }
    }, this.options.preAuthTimeoutMs)
    timer.unref?.()
    this.preAuthTimers.set(adapter, timer)
    this.options.heartbeat.noteAlive(adapter)
    if (this.adapterClients.size === 1) {
      this.options.heartbeat.start(() => this.adapterClients)
    }
  }

  private handleMessage(
    socket: BunServerWebSocket,
    message: string | ArrayBuffer | Uint8Array
  ): void {
    const adapter = this.adapters.get(socket)
    if (!adapter) {
      socket.terminate()
      return
    }
    const payload = typeof message === 'string' ? message : new Uint8Array(message as ArrayBuffer)
    this.options.heartbeat.noteAlive(adapter)
    this.options.callbacks.messageHandler(
      payload,
      (response) => {
        if (adapter.readyState === adapter.OPEN) {
          adapter.send(response)
        }
      },
      adapter
    )
  }

  private handleClose(socket: BunServerWebSocket): void {
    if (!this.clients.delete(socket)) {
      return
    }
    const adapter = this.adapters.get(socket)
    if (!adapter) {
      return
    }
    this.clearPreAuthTimer(adapter)
    this.adapterClients.delete(adapter)
    this.adapters.delete(socket)
    if (this.adapterClients.size === 0) {
      this.options.heartbeat.stop()
    }
    const clientId = this.clientIds.get(adapter) ?? null
    this.clientIds.delete(adapter)
    const hasOtherConnections =
      clientId !== null && Array.from(this.clientIds.values()).includes(clientId)
    try {
      adapter.notify('close')
    } finally {
      this.options.callbacks.connectionCloseHandler(clientId, adapter, hasOtherConnections)
    }
  }

  private handleError(socket: BunServerWebSocket, error: unknown): void {
    try {
      this.adapters.get(socket)?.notify('error', error)
    } finally {
      try {
        this.handleClose(socket)
      } finally {
        socket.terminate()
      }
    }
  }

  private findSocket(ws: WebSocket): BunSocketAdapter | null {
    return this.adapterClients.has(ws as BunSocketAdapter) ? (ws as BunSocketAdapter) : null
  }

  private clearPreAuthTimer(ws: object): void {
    const timer = this.preAuthTimers.get(ws)
    if (timer) {
      clearTimeout(timer)
      this.preAuthTimers.delete(ws)
    }
  }
}
