import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(line: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function rpcId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string'
    ? `j:${JSON.stringify(value)}`
    : null
}

/** Bounds an agent that never answers or floods requests; the oldest unanswered goes first. */
const MAX_PENDING_REQUESTS = 256
const MAX_PENDING_CHARS = 8 * 1024 * 1024
/** An initialize answer comes first; past this many agent lines nothing more is parsed for it. */
const INITIALIZE_WINDOW_LINES = 256

function controlId(value: unknown): string | null {
  return typeof value === 'string' ? `c:${value}` : null
}

/**
 * Agent→client requests still unanswered (JSON-RPC server requests, Claude `control_request`s),
 * kept apart from the spool so an ack of the spool never loses an approval the user still owes.
 * Lines are only parsed when a cheap substring test says they can be a request or its answer.
 */
export class ProviderRelayPendingRequests {
  private readonly pending = new Map<string, ProviderRelayRecord>()
  private pendingChars = 0
  private initializeKey: string | null = null
  private initializeLinesLeft = INITIALIZE_WINDOW_LINES
  private clientLinePartial = ''
  maxClientRequestId: number | null = null
  initializeResult: string | null = null

  get size(): number {
    return this.pending.size
  }

  /** Insertion order is seq order: a re-sent id is removed before it is added again. */
  records(): ProviderRelayRecord[] {
    return [...this.pending.values()]
  }

  clear(): void {
    this.pending.clear()
    this.pendingChars = 0
  }

  private hold(key: string, record: ProviderRelayRecord): void {
    this.release(key)
    this.pending.set(key, record)
    this.pendingChars += record.line.length
    for (const [oldest, held] of this.pending) {
      if (this.pending.size <= MAX_PENDING_REQUESTS && this.pendingChars <= MAX_PENDING_CHARS) {
        break
      }
      this.pending.delete(oldest)
      this.pendingChars -= held.line.length
    }
  }

  private release(key: string): void {
    const held = this.pending.get(key)
    if (held) {
      this.pending.delete(key)
      this.pendingChars -= held.line.length
    }
  }

  observeAgentLine(record: ProviderRelayRecord): void {
    const { line } = record
    const maybeRpcRequest = line.includes('"method"') && line.includes('"id"')
    const maybeControl = line.includes('control_')
    const awaitingInitialize =
      this.initializeKey !== null &&
      this.initializeResult === null &&
      this.initializeLinesLeft-- > 0
    if (!maybeRpcRequest && !maybeControl && !awaitingInitialize) {
      return
    }
    const message = parseObject(line)
    if (!message) {
      return
    }
    if (typeof message.method === 'string') {
      const key = rpcId(message.id)
      if (key) {
        this.hold(key, record)
      }
      return
    }
    if (message.type === 'control_request') {
      const key = controlId(message.request_id)
      if (key) {
        this.hold(key, record)
      }
      return
    }
    if (message.type === 'control_cancel_request') {
      const key = controlId(message.request_id)
      if (key) {
        this.release(key)
      }
      return
    }
    if (awaitingInitialize && this.responseKey(message) === this.initializeKey) {
      this.initializeResult = line
    }
  }

  /** Client writes may split or join lines; only complete lines are classified. */
  observeClientData(data: string): void {
    if (!data.includes('\n')) {
      this.clientLinePartial += data
      return
    }
    const lines = (this.clientLinePartial + data).split('\n')
    this.clientLinePartial = lines.pop() ?? ''
    for (const line of lines) {
      this.observeClientLine(line)
    }
  }

  private observeClientLine(line: string): void {
    if (!line.includes('"id"') && !line.includes('control_')) {
      return
    }
    const message = parseObject(line)
    if (!message) {
      return
    }
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number' && Number.isSafeInteger(message.id)) {
        this.maxClientRequestId = Math.max(this.maxClientRequestId ?? message.id, message.id)
      }
      if (message.method === 'initialize' && this.initializeKey === null) {
        this.initializeKey = rpcId(message.id)
      }
      return
    }
    if (message.type === 'control_request') {
      const { request } = message
      if (isObject(request) && request.subtype === 'initialize' && this.initializeKey === null) {
        this.initializeKey = controlId(message.request_id)
      }
      return
    }
    const key = this.responseKey(message)
    if (key) {
      this.release(key)
    }
  }

  private responseKey(message: JsonObject): string | null {
    if (message.type === 'control_response') {
      const { response } = message
      return isObject(response) ? controlId(response.request_id) : null
    }
    return 'result' in message || 'error' in message ? rpcId(message.id) : null
  }
}
