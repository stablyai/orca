import type { WebSocket } from 'ws'
import type { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'
import { createStaticWebClientResponse } from './static-web-client-handler'

const MAX_WS_CONNECTIONS = 128

type BunServerWebSocket = {
  data: unknown
  closed?: boolean
  send(data: string | ArrayBuffer | ArrayBufferView): number
  close(code?: number, reason?: string): void
  terminate(): void
  ping(data?: string | ArrayBuffer | ArrayBufferView): void
}

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
    tls?: { cert: string; key: string }
    ['fetch'](request: Request, server: BunServer): Response | Promise<Response> | undefined
    websocket: {
      data: Record<string, never>
      open(socket: BunServerWebSocket): void
      message(socket: BunServerWebSocket, message: string | ArrayBuffer | Uint8Array): void
      close(socket: BunServerWebSocket): void
      error?(socket: BunServerWebSocket, error: unknown): void
    }
  }): BunServer
}

type BunGlobal = typeof globalThis & { Bun?: BunRuntime }
type BunSocketAdapter = WebSocket & {
  readonly raw: BunServerWebSocket
  readonly notify: (event: string, ...args: unknown[]) => void
}

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

function adaptBunSocket(socket: BunServerWebSocket): BunSocketAdapter {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const adapted = {
    raw: socket,
    OPEN: 1,
    get readyState(): number {
      return socket.closed ? 3 : 1
    },
    send(data: string | ArrayBuffer | ArrayBufferView): void {
      socket.send(data)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    terminate(): void {
      socket.terminate()
    },
    ping(data?: string | ArrayBuffer | ArrayBufferView): void {
      socket.ping(data)
    },
    on(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return adapted as BunSocketAdapter
    },
    off(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      listeners.get(event)?.delete(listener)
      return adapted as BunSocketAdapter
    },
    once(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      const onceListener = (...args: unknown[]) => {
        listeners.get(event)?.delete(onceListener)
        listener(...args)
      }
      return adapted.on(event, onceListener)
    },
    notify(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args)
      }
    }
  } as unknown as BunSocketAdapter
  return adapted
}

export function canUseBunWebSocketTransport(): boolean {
  return typeof getBunRuntime()?.serve === 'function'
}

export class BunWebSocketTransport {
  private server: BunServer | null = null
  private readonly clients = new Set<BunServerWebSocket>()
  private readonly adapters = new WeakMap<BunServerWebSocket, BunSocketAdapter>()
  private readonly adapterClients = new Set<BunSocketAdapter>()
  private readonly clientIds = new Map<BunSocketAdapter, string>()
  private readonly preAuthTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly options: {
      host: string
      port: number
      staticRoot?: string
      tlsCert?: string
      tlsKey?: string
      preAuthTimeoutMs: number
      heartbeat: RemoteRuntimeServerHeartbeat
      callbacks: BunWebSocketTransportCallbacks
    }
  ) {}

  get resolvedPort(): number {
    return this.server?.port ?? this.options.port
  }

  get resolvedHost(): string | null {
    return this.server?.hostname ?? null
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
      hostname: this.options.host,
      port: this.options.port,
      ...(this.options.tlsCert && this.options.tlsKey
        ? { tls: { cert: this.options.tlsCert, key: this.options.tlsKey } }
        : {}),
      fetch: (request, server) => {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return this.options.staticRoot
            ? createStaticWebClientResponse(this.options.staticRoot, request)
            : new Response('Orca runtime WebSocket endpoint', { status: 426 })
        }
        if (this.clients.size >= MAX_WS_CONNECTIONS) {
          return new Response('Maximum connections reached', { status: 503 })
        }
        return server.upgrade(request)
          ? undefined
          : new Response('WebSocket upgrade failed', { status: 400 })
      },
      websocket: {
        data: {} as Record<string, never>,
        open: (socket) => this.handleOpen(socket),
        message: (socket, message) => this.handleMessage(socket, message),
        error: (socket, error) => {
          this.adapters.get(socket)?.notify('error', error)
          socket.terminate()
        },
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
    if (!server) {
      return
    }
    this.options.heartbeat.stop()
    for (const socket of this.clients) {
      socket.terminate()
    }
    await server.stop({ closeActiveConnections: true })
    for (const socket of this.clients) {
      this.handleClose(socket)
    }
  }

  private handleOpen(socket: BunServerWebSocket): void {
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
    adapter.notify('close')
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
    this.options.callbacks.connectionCloseHandler(clientId, adapter, hasOtherConnections)
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
