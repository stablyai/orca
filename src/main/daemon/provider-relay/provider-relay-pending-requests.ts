import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import {
  leadingJsonEnvelope,
  type LeadingProperty
} from '../../../shared/json-stream/json-rpc-record-prefix'

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

/**
 * Agent lines are gated by their leading envelope fields (`id`, `method`, `type`), which every
 * supported agent writes before its payload. The scan stops at the first object value and never
 * reads past this many chars, so a notification or a plain Claude frame is never parsed.
 */
const ENVELOPE_SCAN_CHARS = 4096

const NON_SPACE = /\S/
const isControlType = (type: string): boolean => type.startsWith('control_')
/** Envelope fields read before the scan gives up and the line is skipped as unusual. */
const ENVELOPE_MAX_FIELDS = 32

function rpcId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string'
    ? `j:${JSON.stringify(value)}`
    : null
}

/** Past these the agent's output pauses until answers come in; a held request is never dropped. */
const MAX_PENDING_REQUESTS = 256
const MAX_PENDING_CHARS = 8 * 1024 * 1024
/** Codex resolves a server request elsewhere (another client, a timeout) and says so with this. */
const RESOLVED_METHOD = 'serverRequest/resolved'

/** A client line longer than this is forwarded but not classified, so it can't grow without bound. */
const MAX_CLIENT_LINE_CHARS = 256 * 1024 * 1024
/** JSON may spell a key or method with escapes (`"m\u0065thod"`, `\u002f`); such lines take the slow path. */
const ESCAPED_LETTER = /\\u00[2-7][0-9a-fA-F]/

function mayHideKey(line: string): boolean {
  return line.includes('\\u00') && ESCAPED_LETTER.test(line)
}

/** A held request and the record it was when its answer was seen. */
type AnsweredRequest = { key: string; record: ProviderRelayRecord }

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
  private clientLinePartial = ''
  private skippingClientLine = false
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
  }

  /** The agent is owed this many answers that it should wait for before saying more. */
  get full(): boolean {
    return this.pending.size >= MAX_PENDING_REQUESTS || this.pendingChars >= MAX_PENDING_CHARS
  }

  private release(key: string): void {
    const held = this.pending.get(key)
    if (held) {
      this.pending.delete(key)
      this.pendingChars -= held.line.length
    }
  }

  /**
   * Lines that may be a request, a cancel, a resolution or the awaited initialize answer are parsed
   * once and classified from the parsed object, so a malformed or duplicate-keyed line is read
   * exactly as the client will read it.
   */
  observeAgentLine(record: ProviderRelayRecord): void {
    if (!this.mayClassify(record.line)) {
      return
    }
    const message = parseObject(record.line)
    if (!message) {
      return
    }
    const { method, type } = message
    if (method === RESOLVED_METHOD) {
      const key = isObject(message.params) ? rpcId(message.params.requestId) : null
      if (key) {
        this.release(key)
      }
    } else if (typeof method === 'string') {
      const key = rpcId(message.id)
      if (key) {
        this.hold(key, record)
      }
    } else if (type === 'control_request' || type === 'control_cancel_request') {
      const key = controlId(message.request_id)
      if (key && type === 'control_request') {
        this.hold(key, record)
      } else if (key) {
        this.release(key)
      }
    } else if (this.awaitingInitialize && this.responseKey(message) === this.initializeKey) {
      this.initializeResult = record.line
    }
  }

  private get awaitingInitialize(): boolean {
    return this.initializeKey !== null && this.initializeResult === null
  }

  /** False for a line the envelope alone shows is none of those, which is nearly every line. */
  private mayClassify(line: string): boolean {
    const start = line.search(NON_SPACE)
    if (start === -1 || line[start] !== '{') {
      return false
    }
    const head = line.slice(start, start + ENVELOPE_SCAN_CHARS)
    const { properties, complete } = leadingJsonEnvelope(head, {
      stopAtContainer: true,
      maxFields: ENVELOPE_MAX_FIELDS
    })
    const keys = new Set(properties.map((property) => property.key))
    if (keys.size !== properties.length) {
      // JSON.parse keeps a repeated key's last value, which the gate must not second-guess.
      return true
    }
    if (!complete) {
      // Cut by the window before its envelope ended: undecided unless a Claude frame type was read.
      // Otherwise it isn't valid JSON.
      const type = properties.find((property) => property.key === 'type')?.value
      return (
        start + head.length < line.length && !(typeof type === 'string' && !isControlType(type))
      )
    }
    const field = (key: string): LeadingProperty | undefined =>
      properties.find((property) => property.key === key)
    const method = field('method')?.value
    const type = field('type')?.value
    if (typeof method === 'string') {
      return method === RESOLVED_METHOD || field('id') !== undefined
    }
    if (this.awaitingInitialize && (field('result') || field('error'))) {
      return true
    }
    return (
      type === 'control_request' ||
      type === 'control_cancel_request' ||
      (type === 'control_response' && this.awaitingInitialize)
    )
  }

  /**
   * Client writes may split or join lines; only complete lines are classified. Returns the held
   * requests this data answers; the owner releases them once the data has reached the agent.
   */
  observeClientData(data: string): AnsweredRequest[] {
    const answered: AnsweredRequest[] = []
    let start = 0
    let newline = data.indexOf('\n')
    while (newline !== -1) {
      if (!this.skippingClientLine) {
        const key = this.observeClientLine(this.clientLinePartial + data.slice(start, newline))
        const record = key ? this.pending.get(key) : undefined
        if (key && record) {
          answered.push({ key, record })
        }
      }
      this.clientLinePartial = ''
      this.skippingClientLine = false
      start = newline + 1
      newline = data.indexOf('\n', start)
    }
    if (start < data.length && !this.skippingClientLine) {
      this.clientLinePartial += data.slice(start)
      if (this.clientLinePartial.length > MAX_CLIENT_LINE_CHARS) {
        this.clientLinePartial = ''
        this.skippingClientLine = true
      }
    }
    return answered
  }

  /** The answers reached the agent's stdin; a request re-sent under the same id since then stays held. */
  releaseAnswered(answered: AnsweredRequest[]): void {
    for (const { key, record } of answered) {
      if (this.pending.get(key) === record) {
        this.release(key)
      }
    }
  }

  private observeClientLine(line: string): string | null {
    if (!line.includes('"id"') && !line.includes('control_') && !mayHideKey(line)) {
      return null
    }
    const message = parseObject(line)
    if (!message) {
      return null
    }
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number' && Number.isSafeInteger(message.id)) {
        this.maxClientRequestId = Math.max(this.maxClientRequestId ?? message.id, message.id)
      }
      if (message.method === 'initialize' && this.initializeKey === null) {
        this.initializeKey = rpcId(message.id)
      }
      return null
    }
    if (message.type === 'control_request') {
      const { request } = message
      if (isObject(request) && request.subtype === 'initialize' && this.initializeKey === null) {
        this.initializeKey = controlId(message.request_id)
      }
      return null
    }
    return this.responseKey(message)
  }

  private responseKey(message: JsonObject): string | null {
    if (message.type === 'control_response') {
      const { response } = message
      return isObject(response) ? controlId(response.request_id) : null
    }
    return 'result' in message || 'error' in message ? rpcId(message.id) : null
  }
}
