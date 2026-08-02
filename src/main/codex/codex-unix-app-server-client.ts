import { createConnection } from 'node:net'
import WebSocket, { type RawData } from 'ws'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CodexUnixAppServerClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.onMessage(data))
    socket.on('close', () =>
      this.failPending(new Error('controlled Codex app-server disconnected'))
    )
    socket.on('error', (error) => this.failPending(error))
  }

  static async connect(socketPath: string, timeoutMs = 10_000): Promise<CodexUnixAppServerClient> {
    const socket = new WebSocket('ws://localhost/rpc', {
      perMessageDeflate: false,
      createConnection: () => createConnection(socketPath)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          cleanup()
          resolve()
        }
        const onError = (error: Error): void => {
          cleanup()
          reject(error)
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('controlled Codex socket connect timed out'))
        }, timeoutMs)
        timer.unref?.()
        const cleanup = (): void => {
          clearTimeout(timer)
          socket.removeListener('open', onOpen)
          socket.removeListener('error', onError)
        }
        socket.once('open', onOpen)
        socket.once('error', onError)
      })
      const client = new CodexUnixAppServerClient(socket)
      const initializeResult = await client.request('initialize', {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      })
      client.initializeResult = initializeResult
      client.notify('initialized')
      return client
    } catch (error) {
      socket.once('error', () => {})
      socket.terminate()
      throw error
    }
  }

  initializeResult: unknown = null

  request(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`controlled Codex ${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }), (error) => {
        if (!error) {
          return
        }
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ method, ...(params ? { params } : {}) }))
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  close(): void {
    this.socket.close()
  }

  private onMessage(data: RawData): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      const error = message.error as { message?: string; code?: number; data?: unknown } | undefined
      if (error) {
        pending.reject(
          Object.assign(new Error(error.message ?? 'controlled Codex RPC failed'), {
            rpcCode: error.code ?? null,
            rpcData: error.data ?? null
          })
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method !== 'string') {
      return
    }
    const params = isRecord(message.params) ? message.params : {}
    for (const listener of this.notificationListeners) {
      try {
        listener(message.method, params)
      } catch {
        // One observer must not prevent delivery to the remaining observers.
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
