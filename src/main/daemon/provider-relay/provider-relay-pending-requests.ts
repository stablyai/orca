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

/** Top-level fields of a line the envelope scan could not finish; non-scalar values carry no value. */
function wholeLineFields(line: string): LeadingProperty[] {
  const message = parseObject(line)
  return Object.entries(message ?? {}).map(([key, value]) =>
    typeof value === 'string' || typeof value === 'number' ? { key, value } : { key }
  )
}

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
/**
 * Agent lines are classified from their leading envelope fields only (`id`, `method`, `type`,
 * `request_id`), which every supported agent writes before its payload. The scan stops at the first
 * object value and never reads past this many chars, so a notification is never parsed whole; a line
 * whose envelope the scan can't finish (cut by this limit, or unusual) is parsed whole instead.
 */
const ENVELOPE_SCAN_CHARS = 4096

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

  observeAgentLine(record: ProviderRelayRecord): void {
    const { line } = record
    const head = line.length > ENVELOPE_SCAN_CHARS ? line.slice(0, ENVELOPE_SCAN_CHARS) : line
    const envelope = leadingJsonEnvelope(head, { stopAtContainer: true })
    const fields = envelope.complete ? envelope.properties : wholeLineFields(line)
    const field = (key: string): LeadingProperty | undefined =>
      fields.find((property) => property.key === key)
    const method = field('method')?.value
    const type = field('type')?.value
    if (method === RESOLVED_METHOD) {
      // Rare, and its request id sits inside `params`, so this one notification is parsed.
      const message = parseObject(line)
      const key = isObject(message?.params) ? rpcId(message.params.requestId) : null
      if (key) {
        this.release(key)
      }
      return
    }
    if (typeof method === 'string') {
      const key = rpcId(field('id')?.value)
      if (key) {
        this.hold(key, record)
      }
      return
    }
    if (type === 'control_request' || type === 'control_cancel_request') {
      const key = controlId(field('request_id')?.value)
      if (key && type === 'control_request') {
        this.hold(key, record)
      } else if (key) {
        this.release(key)
      }
      return
    }
    if (this.initializeKey === null || this.initializeResult !== null) {
      return
    }
    // A Claude answer keeps its request id inside `response`; only that line is parsed.
    // Codex writes `error` before `id`; with no id ahead of the payload, this one line is parsed.
    const answerId = field('id')?.value
    const answerKey =
      type === 'control_response' || ((field('result') || field('error')) && answerId === undefined)
        ? this.responseKeyOf(line)
        : field('result') || field('error')
          ? rpcId(answerId)
          : null
    // A malformed line can't stand in for the answer a reattaching client is handed.
    if (answerKey === this.initializeKey && (type === 'control_response' || parseObject(line))) {
      this.initializeResult = line
    }
  }

  private responseKeyOf(line: string): string | null {
    const message = parseObject(line)
    return message ? this.responseKey(message) : null
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
