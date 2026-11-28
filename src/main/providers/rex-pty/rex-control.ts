import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { rexPendingRpcBudget } from './rex-memory-budget'
import { classifyRexRpcRejection } from './rex-rpc-rejection'
import { handshakeRexWire, type RexWire } from './rex-wire'

const TIMEOUT = 5000
const welcomeSchema = lazyZodSchema(() =>
  z.object({
    type: z.literal('welcome'),
    api_revision: z.literal(24),
    protocol: z.literal('rex.control.v1').optional(),
    client: z
      .object({
        id: z.string(),
        reconnect_token: z.string(),
        resumed: z.boolean().optional()
      })
      .nullish(),
    limits: z.object({ max_message_bytes: z.number().int().positive() }).optional()
  })
)
const responseSchema = lazyZodSchema(() =>
  z.object({
    type: z.literal('response'),
    id: z.string(),
    error: z.unknown().optional(),
    payload: z.unknown().optional()
  })
)

type Connection = {
  wire: RexWire
  clientId?: string
  token?: string
  resumed?: boolean
  maxMessage: number
}

async function handshake(path: string, token?: string, signal?: AbortSignal): Promise<Connection> {
  return handshakeRexWire(
    path,
    '/api/control',
    'rex.control.v1',
    async (wire) => {
      wire.send(
        JSON.stringify({
          type: 'hello',
          api_revision: 24,
          api_min_revision: 24,
          client: {
            kind: 'app',
            name: 'Orca',
            version: '0.0.1',
            platform: process.platform === 'darwin' ? 'macos' : process.platform
          },
          ...(token ? { reconnect_token: token } : {})
        })
      )
      const welcome = welcomeSchema.parse(JSON.parse((await wire.next(TIMEOUT)).toString()))
      return {
        wire,
        clientId: welcome.client?.id,
        token: welcome.client?.reconnect_token,
        resumed: welcome.client?.resumed,
        maxMessage: Math.min(welcome.limits?.max_message_bytes ?? 1024 * 1024, 1024 * 1024)
      }
    },
    signal
  )
}

export class RexControl {
  private id = 0
  private requests = new Map<
    string,
    {
      method: string
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      release: () => void
    }
  >()
  private readonly lifetime = new AbortController()
  private recovery?: Promise<void>
  private closedCallbacks = new Set<() => void>()

  private get closed(): boolean {
    return this.lifetime.signal.aborted
  }

  private constructor(
    private readonly path: string,
    private connection: Connection
  ) {}

  static async connect(path: string): Promise<RexControl> {
    const control = new RexControl(path, await handshake(path))
    void control.read()
    return control
  }

  private failPending(): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.release()
      request.reject(new Error('Rex RPC connection lost'))
    }
    this.requests.clear()
  }

  private async recover(previous: Connection): Promise<void> {
    if (!previous.wire.canResume || !previous.token || !previous.clientId || this.closed) {
      throw new Error('Rex control cannot resume')
    }
    previous.wire.close()
    const resumed = await handshake(this.path, previous.token, this.lifetime.signal)
    if (this.closed || !resumed.resumed || resumed.clientId !== previous.clientId) {
      resumed.wire.close()
      throw new Error('Rex control resume identity mismatch')
    }
    this.connection = resumed
  }

  private async read(): Promise<void> {
    while (!this.closed) {
      const previous = this.connection
      try {
        const raw: unknown = JSON.parse((await previous.wire.next()).toString())
        if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
          throw new Error('Invalid Rex control message')
        }
        if (raw.type !== 'response') {
          continue
        }
        const msg = responseSchema.parse(raw)
        const request = this.requests.get(msg.id)
        if (!request) {
          continue
        }
        this.requests.delete(msg.id)
        clearTimeout(request.timer)
        request.release()
        if (msg.error) {
          request.reject(classifyRexRpcRejection(request.method, msg.error))
        } else {
          request.resolve(msg.payload)
        }
      } catch {
        if (this.closed) {
          return
        }
        // Every in-flight request is ambiguous; none is replayed.
        this.failPending()
        try {
          this.recovery = this.recover(previous)
          await this.recovery
        } catch {
          this.close()
        } finally {
          this.recovery = undefined
        }
      }
    }
  }

  call<T>(method: string, payload: unknown, decode: (value: unknown) => T): Promise<T>
  call(method: string, payload: unknown): Promise<unknown>
  async call(
    method: string,
    payload: unknown,
    decode?: (value: unknown) => unknown
  ): Promise<unknown> {
    if (this.recovery) {
      await this.recovery
    }
    if (this.closed) {
      throw new Error('Rex control closed')
    }
    if (this.requests.size >= 128) {
      throw new Error('Rex RPC queue full')
    }
    const id = String(++this.id)
    const message = JSON.stringify({ type: 'request', id, method, payload })
    if (Buffer.byteLength(message) > this.connection.maxMessage) {
      throw new Error('Rex RPC exceeds message limit')
    }
    const release = rexPendingRpcBudget.reserve(Buffer.byteLength(message) + 128)
    if (!release) {
      throw new Error('Rex aggregate RPC budget exhausted')
    }
    const pending = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        release()
        reject(new Error('Rex RPC timeout'))
      }, TIMEOUT)
      this.requests.set(id, { method, resolve, reject, timer, release })
      try {
        this.connection.wire.send(message)
      } catch (error) {
        clearTimeout(timer)
        this.requests.delete(id)
        release()
        reject(error)
      }
    })
    return decode ? pending.then(decode) : pending
  }

  get isClosed(): boolean {
    return this.closed
  }

  onClosed(callback: () => void): () => void {
    if (this.closed) {
      callback()
      return () => {}
    }
    this.closedCallbacks.add(callback)
    return () => this.closedCallbacks.delete(callback)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.lifetime.abort(new Error('Rex control closed'))
    this.connection.wire.close()
    this.failPending()
    for (const callback of this.closedCallbacks) {
      callback()
    }
    this.closedCallbacks.clear()
  }
}
