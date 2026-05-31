/* eslint-disable max-lines -- Why: daemon handshake, RPC, stream events, and reconnect cleanup share one socket lifecycle. */
import { connect, type Socket } from 'net'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { PROTOCOL_VERSION, NOTIFY_PREFIX, DaemonProtocolError } from './types'
import type { HelloMessage, HelloResponse, RpcResponse, DaemonEvent } from './types'
import { addNodePtyRecoveryHint } from './node-pty-error-hints'

const CONNECT_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 30000

export type DaemonClientOptions = {
  socketPath: string
  tokenPath: string
  protocolVersion?: number
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DaemonClient {
  private socketPath: string
  private tokenPath: string
  private protocolVersion: number
  private clientId = randomUUID()

  private controlSocket: Socket | null = null
  private streamSocket: Socket | null = null
  private connected = false
  private disconnectArmed = false
  // Why: after a disconnect + reconnect (daemon respawn), a stale 'close'
  // event from the old sockets can fire. Without a generation check, that
  // event would tear down the fresh connection. Each doConnect() increments
  // the generation; handleDisconnect ignores events from old generations.
  private connectionGeneration = 0
  // Why: multiple concurrent spawn() calls from simultaneous pane mounts
  // all call ensureConnected(). Without a lock, each starts a separate
  // connection attempt, overwriting sockets and triggering "Connection lost".
  private connectingPromise: Promise<void> | null = null

  private pendingRequests = new Map<string, PendingRequest>()
  private eventListeners: ((event: unknown) => void)[] = []
  private disconnectedListeners: (() => void)[] = []
  private requestCounter = 0
  private cleanupSocketListeners: (() => void) | null = null

  constructor(opts: DaemonClientOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
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
    const pendingListenerCleanups: (() => void)[] = []
    const cleanupPendingListeners = (): void => {
      for (const cleanup of pendingListenerCleanups.splice(0)) {
        cleanup()
      }
    }

    try {
      // Sequential: control first, then stream
      this.controlSocket = await this.connectSocket()
      await this.sendHello(this.controlSocket, token, 'control')
      pendingListenerCleanups.push(this.setupControlParser(this.controlSocket))

      this.streamSocket = await this.connectSocket()
      await this.sendHello(this.streamSocket, token, 'stream')
      pendingListenerCleanups.push(this.setupStreamParser(this.streamSocket))

      this.connected = true
      this.disconnectArmed = true
      this.connectionGeneration++

      const gen = this.connectionGeneration
      const handleClose = () => this.handleDisconnect(gen)
      const controlSocket = this.controlSocket
      const streamSocket = this.streamSocket
      controlSocket.on('close', handleClose)
      controlSocket.on('error', handleClose)
      streamSocket.on('close', handleClose)
      streamSocket.on('error', handleClose)
      pendingListenerCleanups.push(() => {
        controlSocket.off('close', handleClose)
        controlSocket.off('error', handleClose)
        streamSocket.off('close', handleClose)
        streamSocket.off('error', handleClose)
      })
      this.cleanupSocketListeners = cleanupPendingListeners
    } catch (error) {
      cleanupPendingListeners()
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
    this.cleanupActiveSocketListeners()

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
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
      }
      const onConnect = (): void => {
        cleanup()
        resolve(socket)
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new DaemonProtocolError('Connection timed out'))
      }, CONNECT_TIMEOUT_MS)

      socket.on('connect', onConnect)
      socket.on('error', onError)
    })
  }

  private sendHello(socket: Socket, token: string, role: 'control' | 'stream'): Promise<void> {
    return new Promise((resolve, reject) => {
      const hello: HelloMessage = {
        type: 'hello',
        version: this.protocolVersion,
        token,
        clientId: this.clientId,
        role
      }

      let buffer = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
      }
      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (error) {
          reject(error)
          return
        }
        resolve()
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString()
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          return
        }

        const line = buffer.slice(0, newlineIdx)
        try {
          const response = JSON.parse(line) as HelloResponse
          if (response.ok) {
            finish()
          } else {
            finish(
              new DaemonProtocolError(addNodePtyRecoveryHint(response.error ?? 'Hello rejected'))
            )
          }
        } catch {
          finish(new DaemonProtocolError('Invalid hello response'))
        }
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (): void =>
        finish(new DaemonProtocolError('Connection closed before hello response'))

      timer = setTimeout(() => {
        // Why: a stale daemon can accept the socket but never answer hello;
        // without a handshake timeout, startup waits forever on ensureConnected().
        finish(new DaemonProtocolError('Hello response timed out'))
        socket.destroy()
      }, CONNECT_TIMEOUT_MS)
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.write(encodeNdjson(hello))
    })
  }

  private setupControlParser(socket: Socket): () => void {
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
              pending.reject(new DaemonProtocolError(addNodePtyRecoveryHint(response.error)))
            }
          }
        }
      },
      () => {} // Ignore parse errors on control socket
    )

    const onData = (chunk: Buffer) => parser.feed(chunk.toString())
    socket.on('data', onData)
    return () => socket.off('data', onData)
  }

  private setupStreamParser(socket: Socket): () => void {
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

    const onData = (chunk: Buffer) => parser.feed(chunk.toString())
    socket.on('data', onData)
    return () => socket.off('data', onData)
  }

  private handleDisconnect(generation: number): void {
    if (!this.disconnectArmed || generation !== this.connectionGeneration) {
      return
    }
    this.disconnectArmed = false
    this.connected = false
    this.cleanupActiveSocketListeners()

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

  private cleanupActiveSocketListeners(): void {
    const cleanup = this.cleanupSocketListeners
    this.cleanupSocketListeners = null
    cleanup?.()
  }
}
