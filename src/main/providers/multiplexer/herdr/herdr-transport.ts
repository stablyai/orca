import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, connect, type Socket, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { HerdrRuntimeError } from './herdr-runtime-contract'

export type HerdrRequest = {
  id: string
  method: string
  params: unknown
}

export type HerdrResponse = {
  id: string
  result?: unknown
  error?: { code: string; message: string } | null
}

export type HerdrNotification = {
  method: string
  params: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const SOCKET_NAME = 'herdr-daemon'
const REQUEST_TIMEOUT_MS = 30_000

// Why: macOS/BSD reject unix socket paths longer than the ~104-byte sun_path
// limit with EINVAL. A deep HOME (isolated e2e profiles, long usernames) can
// exceed it, so getDefaultSocketPath falls back to a short hashed tmpdir path.
const SOCKET_PATH_LIMIT = 104

export function getDefaultSocketPath(): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${SOCKET_NAME}`
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? join(homedir(), '.local', 'share', 'orca')
  const socketPath = join(runtimeDir, `${SOCKET_NAME}.sock`)
  if (Buffer.byteLength(socketPath) <= SOCKET_PATH_LIMIT) {
    return socketPath
  }
  const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 16)
  return join(tmpdir(), `orca-herdr-${digest}.sock`)
}

type ServerClient = {
  socket: Socket
  buffer: string
  closed: boolean
  subscriptions: Set<string> | null
}

// Reply handle handed to a server request handler so the response is written to the
// originating connection. The protocol is one request per connection: the socket is
// closed after the first response unless keepOpen() was called (e.g. events.subscribe).
export type HerdrServerReply = {
  respond(result: unknown): void
  respondError(error: unknown): void
  keepOpen(): void
  // Registers the connection for {event, data} pushes. Without it the socket
  // still stays open (keepOpen) but notifyEvent skips it.
  subscribe(kinds: string[]): void
}

export type HerdrServerRequest = HerdrRequest & HerdrServerReply

export class HerdrTransport extends EventEmitter {
  private socket: Socket | Duplex | null = null
  private server: Server | null = null
  private buffer = ''
  private pendingRequests = new Map<string, PendingRequest>()
  private messageId = 0
  private clients = new Set<ServerClient>()

  static getDefaultSocketPath(): string {
    return getDefaultSocketPath()
  }

  constructor(private readonly socketPath: string = getDefaultSocketPath()) {
    super()
  }

  async startServer(): Promise<void> {
    if (this.server) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => {
        this.acceptClient(socket)
      })

      this.server.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          reject(new HerdrRuntimeError('socket_in_use', `Socket ${this.socketPath} already in use`))
        } else {
          reject(err)
        }
      })

      this.server.listen(this.socketPath, () => {
        resolve()
      })
    })
  }

  private acceptClient(socket: Socket): void {
    const client: ServerClient = { socket, buffer: '', closed: false, subscriptions: null }
    this.clients.add(client)
    this.setupServerClient(client)
    this.emit('clientConnected', socket)
  }

  private setupServerClient(client: ServerClient): void {
    client.socket.on('data', (data) => {
      client.buffer += data.toString('utf8')
      this.processServerBuffer(client)
    })

    client.socket.on('close', () => {
      client.closed = true
      this.clients.delete(client)
      this.emit('disconnect', client.socket)
    })

    client.socket.on('error', () => {
      // Why: per-client socket errors (EPIPE on abrupt disconnect) are expected;
      // the close handler already removes the client. Re-emitting would crash
      // the server because EventEmitter throws on unhandled 'error' events.
    })
  }

  private processServerBuffer(client: ServerClient): void {
    const lines = client.buffer.split('\n')
    client.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const candidate = message as Partial<HerdrRequest>
      if (typeof candidate.id === 'string' && typeof candidate.method === 'string') {
        this.dispatchServerRequest(client, candidate as HerdrRequest)
      } else if (typeof candidate.method === 'string') {
        this.emit('notification', candidate as HerdrNotification)
      }
    }
  }

  private dispatchServerRequest(client: ServerClient, request: HerdrRequest): void {
    let responded = false

    const send = (envelope: HerdrResponse): void => {
      if (responded || client.closed) {
        return
      }
      responded = true
      // Why: a void result would be dropped by JSON.stringify, leaving a bare
      // {id} that the client cannot classify as a response and would hang on.
      const normalized: HerdrResponse = {
        id: envelope.id,
        result: envelope.result ?? null,
        error: envelope.error ?? null
      }
      client.socket.write(`${JSON.stringify(normalized)}\n`)
      // Why: the server keeps the connection open so persistent clients (the
      // daemon host transport) can send multiple requests and receive pushed
      // events on the same socket. Per-request clients close themselves.
    }

    const reply: HerdrServerReply = {
      respond: (result: unknown) => send({ id: request.id, result }),
      respondError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof HerdrRuntimeError ? error.code : 'internal_error'
        send({ id: request.id, error: { code, message } })
      },
      keepOpen: () => {},
      subscribe: (kinds: string[]) => {
        client.subscriptions = new Set(kinds)
      }
    }

    this.emit('request', { ...request, ...reply } as HerdrServerRequest)
  }

  async connect(): Promise<void> {
    if (this.socket && 'readyState' in this.socket && this.socket.readyState === 'open') {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath)

      socket.on('connect', () => {
        this.socket = socket
        this.setupSocket(socket)
        resolve()
      })

      socket.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          reject(new HerdrRuntimeError('daemon_unavailable', 'herdr daemon not running'))
        } else {
          reject(err)
        }
      })

      socket.setTimeout(5000, () => {
        reject(new HerdrRuntimeError('connection_timeout', 'Connection to herdr daemon timed out'))
      })
    })
  }

  async connectWithStream(stream: Duplex): Promise<void> {
    if (this.socket) {
      throw new HerdrRuntimeError('already_connected', 'Transport already connected')
    }
    this.socket = stream
    this.setupSocket(stream)
    // Why: a net.Socket arrives in the 'opening' phase; isConnected() requires
    // 'open', so wait for the handshake before any request can run. Channel
    // streams (e.g. ssh2 forwards) advertise no readyState and are ready now.
    if ('readyState' in stream && stream.readyState === 'opening') {
      await new Promise<void>((resolve, reject) => {
        stream.once('connect', () => resolve())
        stream.once('error', reject)
      })
    }
  }

  private setupSocket(socket: Duplex): void {
    socket.on('data', (data) => {
      this.buffer += data.toString('utf8')
      this.processBuffer()
    })

    socket.on('close', () => {
      this.socket = null
      this.emit('disconnect')
    })

    socket.on('error', (err) => {
      this.emit('error', err)
    })
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      try {
        const message = JSON.parse(line)
        if ('id' in message && 'method' in message) {
          this.emit('request', message as HerdrRequest)
        } else if ('id' in message && ('result' in message || 'error' in message)) {
          this.handleResponse(message as HerdrResponse)
        } else if ('method' in message) {
          this.emit('notification', message as HerdrNotification)
        } else if ('event' in message) {
          this.emit('event', message)
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private handleResponse(response: HerdrResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timeout)

    if (response.error) {
      pending.reject(new HerdrRuntimeError(response.error.code, response.error.message))
    } else {
      pending.resolve(response.result)
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isConnected()) {
      throw new HerdrRuntimeError('not_connected', 'Transport not connected')
    }

    const id = String(++this.messageId)
    const request: HerdrRequest = { id, method, params }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new HerdrRuntimeError('request_timeout', `Request ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timeout })

      this.send(request)
    })
  }

  notify(method: string, params: unknown): void {
    const notification: HerdrNotification = { method, params }
    const line = `${JSON.stringify(notification)}\n`
    for (const client of this.clients) {
      if (!client.closed && client.socket.writable) {
        try {
          client.socket.write(line)
        } catch {
          // Why: the peer can end between the writable check and the write.
        }
      }
    }
  }

  // Push a protocol-19 event frame {event, data:{type,...}} to the connections
  // whose events.subscribe registered the matching kind.
  notifyEvent(event: string, data: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ event, data: { type: event, ...data } })}\n`
    for (const client of this.clients) {
      if (client.closed || !client.subscriptions?.has(event) || !client.socket.writable) {
        continue
      }
      try {
        client.socket.write(line)
      } catch {
        // Why: the peer can end between the writable check and the write.
      }
    }
  }

  private send(message: HerdrRequest | HerdrNotification): void {
    if (!this.isConnected() || !this.socket) {
      return
    }
    const line = `${JSON.stringify(message)}\n`
    this.socket.write(line)
  }

  async close(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new HerdrRuntimeError('transport_closed', 'Transport closed'))
    }
    this.pendingRequests.clear()

    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = null
    }
  }

  isConnected(): boolean {
    if (!this.socket) {
      return false
    }
    // Why: readyState is Socket-only; a plain Duplex (connectWithStream,
    // e.g. an SSH-forwarded channel) has no connecting phase to guard.
    if ('readyState' in this.socket) {
      return this.socket.readyState === 'open'
    }
    return !this.socket.destroyed
  }
}

export function createHerdrTransport(socketPath?: string): HerdrTransport {
  return new HerdrTransport(socketPath)
}
