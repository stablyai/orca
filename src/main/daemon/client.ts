import { connect, type Socket } from 'net'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { PROTOCOL_VERSION, NOTIFY_PREFIX, DaemonProtocolError } from './types'
import type { HelloMessage, HelloResponse, RpcResponse, DaemonEvent } from './types'

const CONNECT_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 30000

export type DaemonClientOptions = {
  socketPath: string
  tokenPath: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DaemonClient {
  private socketPath: string
  private tokenPath: string
  private clientId = randomUUID()

  private controlSocket: Socket | null = null
  private streamSocket: Socket | null = null
  private connected = false
  private disconnectArmed = false
  // Why: multiple concurrent spawn() calls from simultaneous pane mounts
  // all call ensureConnected(). Without a lock, each starts a separate
  // connection attempt, overwriting sockets and triggering "Connection lost".
  private connectingPromise: Promise<void> | null = null

  private pendingRequests = new Map<string, PendingRequest>()
  private eventListeners: ((event: unknown) => void)[] = []
  private disconnectedListeners: (() => void)[] = []
  private requestCounter = 0

  constructor(opts: DaemonClientOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
  }

  isConnected(): boolean {
    return this.connected
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) {
      return
    }
    if (this.connectingPromise) {
      return this.connectingPromise
    }

    this.connectingPromise = this.doConnect()
    try {
      await this.connectingPromise
    } finally {
      this.connectingPromise = null
    }
  }

  private async doConnect(): Promise<void> {
    const token = readFileSync(this.tokenPath, 'utf-8').trim()

    try {
      // Sequential: control first, then stream
      this.controlSocket = await this.connectSocket()
      await this.sendHello(this.controlSocket, token, 'control')
      this.setupControlParser()

      this.streamSocket = await this.connectSocket()
      await this.sendHello(this.streamSocket, token, 'stream')
      this.setupStreamParser()

      this.connected = true
      this.disconnectArmed = true

      // Handle socket close
      const handleClose = () => this.handleDisconnect()
      this.controlSocket.on('close', handleClose)
      this.controlSocket.on('error', handleClose)
      this.streamSocket.on('close', handleClose)
      this.streamSocket.on('error', handleClose)
    } catch (error) {
      this.controlSocket?.destroy()
      this.streamSocket?.destroy()
      this.controlSocket = null
      this.streamSocket = null
      this.connected = false
      this.disconnectArmed = false
      throw error
    }
  }

  async request<T = unknown>(type: string, payload: unknown): Promise<T> {
    if (!this.connected || !this.controlSocket) {
      throw new DaemonProtocolError('Not connected')
    }

    const id = `req-${++this.requestCounter}`
    const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new DaemonProtocolError(`Request ${type} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      this.controlSocket!.write(encodeNdjson(msg))
    })
  }

  notify(type: string, payload: unknown): void {
    if (!this.connected || !this.controlSocket) {
      return
    }

    const id = `${NOTIFY_PREFIX}${++this.requestCounter}`
    const msg = { id, type, ...(payload !== undefined ? { payload } : {}) }
    this.controlSocket.write(encodeNdjson(msg))
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.push(listener)
    return () => {
      const idx = this.eventListeners.indexOf(listener)
      if (idx !== -1) {
        this.eventListeners.splice(idx, 1)
      }
    }
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.push(listener)
    return () => {
      const idx = this.disconnectedListeners.indexOf(listener)
      if (idx !== -1) {
        this.disconnectedListeners.splice(idx, 1)
      }
    }
  }

  disconnect(): void {
    this.connected = false
    this.disconnectArmed = false

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new DaemonProtocolError('Disconnected'))
      this.pendingRequests.delete(id)
    }

    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
  }

  private connectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new DaemonProtocolError('Connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      socket.on('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })

      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private sendHello(socket: Socket, token: string, role: 'control' | 'stream'): Promise<void> {
    return new Promise((resolve, reject) => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: this.clientId,
        role
      }

      let buffer = ''
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString()
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          return
        }

        socket.removeListener('data', onData)
        const line = buffer.slice(0, newlineIdx)
        try {
          const response = JSON.parse(line) as HelloResponse
          if (response.ok) {
            resolve()
          } else {
            reject(new DaemonProtocolError(response.error ?? 'Hello rejected'))
          }
        } catch {
          reject(new DaemonProtocolError('Invalid hello response'))
        }
      }

      socket.on('data', onData)
      socket.write(encodeNdjson(hello))
    })
  }

  private setupControlParser(): void {
    if (!this.controlSocket) {
      return
    }

    const parser = createNdjsonParser(
      (msg) => {
        const response = msg as RpcResponse
        if (response.id) {
          const pending = this.pendingRequests.get(response.id)
          if (pending) {
            this.pendingRequests.delete(response.id)
            clearTimeout(pending.timer)
            if (response.ok) {
              pending.resolve(response.payload)
            } else {
              pending.reject(new DaemonProtocolError(response.error))
            }
          }
        }
      },
      () => {} // Ignore parse errors on control socket
    )

    this.controlSocket.on('data', (chunk) => parser.feed(chunk.toString()))
  }

  private setupStreamParser(): void {
    if (!this.streamSocket) {
      return
    }

    const parser = createNdjsonParser(
      (msg) => {
        const event = msg as DaemonEvent
        if (event.type === 'event') {
          for (const listener of this.eventListeners) {
            listener(event)
          }
        }
      },
      () => {} // Ignore parse errors on stream socket
    )

    this.streamSocket.on('data', (chunk) => parser.feed(chunk.toString()))
  }

  private handleDisconnect(): void {
    if (!this.disconnectArmed) {
      return
    }
    this.disconnectArmed = false
    this.connected = false

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new DaemonProtocolError('Connection lost'))
      this.pendingRequests.delete(id)
    }

    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null

    for (const listener of this.disconnectedListeners) {
      listener()
    }
  }
}
