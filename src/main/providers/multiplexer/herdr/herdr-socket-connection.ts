import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import type {
  HerdrSocketEvent,
  HerdrSocketMessage,
  HerdrSocketRequest,
  HerdrSocketResponse,
  HerdrSocketTransportOptions,
  HerdrSocketTransportState
} from './herdr-socket-types'

export function encodeSocketMessage(message: HerdrSocketRequest): string {
  return `${JSON.stringify(message)}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSocketResponse(message: unknown): message is HerdrSocketResponse {
  if (!isPlainObject(message)) {
    return false
  }
  return typeof message.id === 'string' && ('result' in message || 'error' in message)
}

export function isSocketEvent(message: unknown): message is HerdrSocketEvent {
  if (!isPlainObject(message)) {
    return false
  }
  return typeof message.event === 'string' && isPlainObject(message.data)
}

export function decodeSocketMessage(line: string): HerdrSocketResponse | HerdrSocketEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isSocketEvent(parsed) || isSocketResponse(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function createRequest(method: string, params: unknown, id?: string): HerdrSocketRequest {
  return {
    id: id ?? crypto.randomUUID(),
    method,
    params
  }
}

export function createRequestId(): string {
  return crypto.randomUUID()
}

export class HerdrSocketMessageParser {
  private buffer = ''

  feed(chunk: string): HerdrSocketMessage[] {
    this.buffer += chunk
    const messages: HerdrSocketMessage[] = []
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      const decoded = decodeSocketMessage(line)
      if (decoded) {
        messages.push(decoded)
      }
    }
    return messages
  }

  flush(): HerdrSocketMessage[] {
    const messages: HerdrSocketMessage[] = []
    if (this.buffer.trim()) {
      const decoded = decodeSocketMessage(this.buffer)
      if (decoded) {
        messages.push(decoded)
      }
      this.buffer = ''
    }
    return messages
  }

  reset(): void {
    this.buffer = ''
  }
}

export type HerdrSocketConnectionOptions = HerdrSocketTransportOptions & {
  sessionName: string
  // Injectable for tests; defaults to a real UNIX socket connection.
  socketFactory?: (socketPath: string) => Socket
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 15000

// One request per connection. The herdr server closes a non-subscribed
// connection after a single response, so each request uses a fresh socket.
export class HerdrSocketConnection {
  private readonly socketPath: string
  private readonly socketFactory: (socketPath: string) => Socket

  constructor(private readonly options: HerdrSocketConnectionOptions) {
    this.socketPath = options.socketPath ?? defaultHerdrSocketPath(options.sessionName)
    this.socketFactory = options.socketFactory ?? createConnection
  }

  getState(): HerdrSocketTransportState {
    return {
      connected: true,
      socketPath: this.socketPath,
      sessionName: this.options.sessionName
    }
  }

  async connect(): Promise<void> {
    await this.ping()
  }

  async ping(): Promise<unknown> {
    return await this.request('ping', {})
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    return await this.requestWithOptions<T>(method, params)
  }

  async requestWithOptions<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = crypto.randomUUID()
    const request = createRequest(method, params, id)
    const response = await this.roundTrip(
      request,
      timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    )
    if (response.error) {
      throw new HerdrRuntimeError(response.error.code, response.error.message)
    }
    return response.result as T
  }

  private roundTrip(
    request: ReturnType<typeof createRequest>,
    timeoutMs: number
  ): Promise<HerdrSocketResponse> {
    const socketPath = this.socketPath
    const connectTimeout = this.options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

    return new Promise<HerdrSocketResponse>((resolve, reject) => {
      let socket: Socket | null = null
      let settled = false
      let connectTimer: NodeJS.Timeout | null = null
      let requestTimer: NodeJS.Timeout | null = null
      const parser = new HerdrSocketMessageParser()

      const finish = (error: Error | null, response?: HerdrSocketResponse): void => {
        if (settled) {
          return
        }
        settled = true
        if (connectTimer) {
          clearTimeout(connectTimer)
        }
        if (requestTimer) {
          clearTimeout(requestTimer)
        }
        if (socket) {
          socket.destroy()
          socket = null
        }
        if (error) {
          reject(error)
        } else if (response) {
          resolve(response)
        } else {
          reject(new Error('herdr socket request produced no response'))
        }
      }

      const acceptResponse = (message: unknown): boolean => {
        // Server errors for invalid requests carry an empty id; surface them so
        // the real cause is not masked as "closed before response".
        if (
          isSocketResponse(message) &&
          (message.id === request.id || (message.error !== undefined && !message.id))
        ) {
          finish(null, message)
          return true
        }
        return false
      }

      connectTimer = setTimeout(() => {
        finish(new Error(`Connection to ${socketPath} timed out`))
      }, connectTimeout)

      socket = this.socketFactory(socketPath)

      socket.once('connect', () => {
        if (connectTimer) {
          clearTimeout(connectTimer)
          connectTimer = null
        }
        requestTimer = setTimeout(() => {
          finish(new Error(`Request ${request.method} timed out`))
        }, timeoutMs)
        socket!.write(encodeSocketMessage(request), (error) => {
          if (error) {
            finish(error)
          }
        })
      })

      socket.on('data', (chunk: Buffer) => {
        for (const message of parser.feed(chunk.toString('utf8'))) {
          if (acceptResponse(message)) {
            return
          }
        }
      })

      socket.once('error', (error: Error) => {
        finish(error)
      })

      socket.once('close', () => {
        for (const message of parser.flush()) {
          if (acceptResponse(message)) {
            return
          }
        }
        finish(new Error(`Connection to ${socketPath} closed before response to ${request.method}`))
      })
    })
  }
}

export function defaultHerdrSocketPath(sessionName: string): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
  const configRoot =
    xdgConfig || join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.config')
  return join(configRoot, 'herdr', 'sessions', sessionName, 'herdr.sock')
}
