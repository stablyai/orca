import { ProviderRelayAnsweredRequests } from './provider-relay-answered-requests'
import {
  leadingJsonEnvelope,
  type LeadingProperty
} from '../../../shared/json-stream/json-rpc-record-prefix'
import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayKeptState } from './provider-relay-kept-state'
import {
  isObject,
  parseObject,
  ProviderRelayStartApprovals
} from './provider-relay-start-approvals'

type JsonObject = Record<string, unknown>

/**
 * Agent lines are gated by their leading envelope fields (`id`, `method`, `type`), which every
 * supported agent writes before its payload. The scan stops at the first object value and never
 * reads past this many chars, so a notification or a plain Claude frame is never parsed.
 */
const ENVELOPE_SCAN_CHARS = 4096

const NON_SPACE = /\S/
/** Envelope fields read before the scan gives up and the substring gate decides. */
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
const RESOLVED_METHOD_ESCAPED = 'serverRequest\\/resolved'
/** The envelope keys that decide how a line is handled; a repeat of any other key is irrelevant. */
const ROUTING_KEYS = new Set(['id', 'method', 'type', 'request_id', 'result', 'error'])

/** A client line longer than this is forwarded but not classified, so it can't grow without bound. */
const MAX_CLIENT_LINE_CHARS = 256 * 1024 * 1024
/** JSON may spell a key or method with escapes (`"m\u0065thod"`, `\u002f`); such lines take the slow path. */
const ESCAPED_LETTER = /\\u00[2-7][0-9a-fA-F]/

export function mayHideKey(line: string): boolean {
  return line.includes('\\u00') && ESCAPED_LETTER.test(line)
}

/** A client line without these substrings can't be a request, a cancel or an answer. */
function mayCarryKey(line: string): boolean {
  return line.includes('"id"') || line.includes('control_') || mayHideKey(line)
}

/** A held request and the record it was when its answer was seen. */
type AnsweredRequest = { key: string; record: ProviderRelayRecord }

const controlId = (value: unknown): string | null =>
  typeof value === 'string' ? `c:${value}` : null

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
  /** Client request methods that are work until answered (a root turn no agent line opens). */
  workMethods: ReadonlySet<string> = new Set()
  /** Those requests still unanswered, by id. */
  readonly working = new Set<string>()
  /** Session state kept for the next attach, as `relaySpawn` named it. */
  readonly kept = new ProviderRelayKeptState()

  /** Held requests whose answer from the app is being written. */
  // Each held request whose answer is being written, by key; a re-sent one replaces it.
  private readonly writing = new Map<string, ProviderRelayRecord>()
  /** Writes a line to the agent while no app is attached; false while one is. */
  toAgent: ((line: string) => boolean) | null = null
  /** Spooled requests already answered, resolved or replaced, so a replay never asks again. */
  readonly answered: ProviderRelayAnsweredRequests

  constructor(ackedSeq: () => number = () => 0) {
    this.answered = new ProviderRelayAnsweredRequests(ackedSeq)
  }

  get size(): number {
    return this.pending.size
  }

  private readonly starts = new ProviderRelayStartApprovals()

  setStartMethods(methods: readonly string[]): void {
    this.starts.setMethods(methods, this.pending)
  }

  /** True while a waiting request asks to start this item: it hasn't started running. */
  awaitingStart(itemId: string): boolean {
    return this.starts.awaits(itemId)
  }

  /** Insertion order is seq order: a re-sent id is removed before it is added again. */
  records(): ProviderRelayRecord[] {
    return [...this.pending.values()]
  }

  clear(): void {
    this.working.clear()
    this.pending.clear()
    this.writing.clear()
    this.starts.clear()
    this.pendingChars = 0
  }

  /** Answers a request the keep spec gives a fixed reply, while no app is attached to. */
  private answerItself(method: string, id: unknown): boolean {
    const result = this.kept.reply(method)
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`
    return result !== undefined && this.toAgent?.(line) === true
  }

  private hold(key: string, record: ProviderRelayRecord, method?: string, params?: unknown): void {
    // Re-sent under its id: an answer once being written (maybe failed) is not this one's.
    this.writing.delete(key)
    this.release(key)
    this.pending.set(key, record)
    this.pendingChars += record.line.length
    if (method !== undefined) {
      this.starts.hold(key, method, params)
    }
  }

  /** The agent is owed this many answers that it should wait for before saying more. */
  get full(): boolean {
    return (
      this.pending.size >= MAX_PENDING_REQUESTS ||
      this.pendingChars + this.kept.chars >= MAX_PENDING_CHARS
    )
  }

  private release(key: string): void {
    const held = this.pending.get(key)
    if (held) {
      this.pending.delete(key)
      this.pendingChars -= held.line.length
      this.answered.add(held.seq)
    }
    this.starts.release(key)
  }

  /**
   * Lines that may be a request, a cancel, a resolution or the awaited initialize answer are parsed
   * once and classified from the parsed object, so a malformed or duplicate-keyed line is read
   * exactly as the client will read it.
   */
  observeAgentLine(record: ProviderRelayRecord): void {
    this.kept.observeAgentLine(record)
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
      if (key && this.answerItself(method, message.id)) {
        // Answered already, so a replay never asks the app again.
        this.answered.add(record.seq)
      } else if (key) {
        this.hold(key, record, method, message.params)
      }
    } else if (type === 'control_request' || type === 'control_cancel_request') {
      const key = controlId(message.request_id)
      if (key && type === 'control_request') {
        this.hold(key, record)
      } else if (key) {
        this.release(key)
      }
    } else {
      const key = this.responseKey(message)
      if (this.awaitingInitialize && key === this.initializeKey) {
        this.initializeResult = record.line
      }
      if (key) {
        this.working.delete(key)
        this.kept.observeAnswer(key, 'result' in message, record)
      }
    }
  }

  /** An answer this table waits for: the first initialize's, or a work request's. */
  private get awaitingAnswer(): boolean {
    return this.awaitingInitialize || this.working.size > 0 || this.kept.awaiting
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
    const routing = properties.filter((property) => ROUTING_KEYS.has(property.key))
    if (new Set(routing.map((property) => property.key)).size !== routing.length) {
      // JSON.parse keeps a repeated key's last value, which the envelope gate must not second-guess.
      return this.mayClassifyBySubstring(line)
    }
    if (!complete) {
      // Cut by the window or the field limit: undecided, so gated by the substring test the base
      // used for every agent line; such lines are never parsed more often than before.
      return this.mayClassifyBySubstring(line)
    }
    const field = (key: string): LeadingProperty | undefined =>
      properties.find((property) => property.key === key)
    const method = field('method')?.value
    const type = field('type')?.value
    if (typeof method === 'string') {
      return method === RESOLVED_METHOD || field('id') !== undefined
    }
    if (this.awaitingAnswer && (field('result') || field('error'))) {
      return true
    }
    return (
      type === 'control_request' ||
      type === 'control_cancel_request' ||
      (type === 'control_response' && this.awaitingInitialize)
    )
  }

  private mayClassifyBySubstring(line: string): boolean {
    const maybeRequest =
      line.includes('"method"') &&
      (line.includes('"id"') ||
        line.includes(RESOLVED_METHOD) ||
        line.includes(RESOLVED_METHOD_ESCAPED))
    const maybeAnswer =
      this.awaitingAnswer && (line.includes('"result"') || line.includes('"error"'))
    return maybeRequest || maybeAnswer || line.includes('control_') || mayHideKey(line)
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
          this.writing.set(key, record)
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

  /** Once no app is attached: an app's cut-off line is ended (for the agent and for this table),
   *  and held requests with a fixed reply are answered, but not one whose answer from the app is
   *  still being written. */
  answerHeld(): void {
    this.clientLinePartial = ''
    this.skippingClientLine = false
    this.toAgent?.('')
    const methods = this.kept.replyMethods
    for (const [key, record] of methods.length > 0 ? this.pending : []) {
      const named = methods.some(
        (method) =>
          record.line.includes(method) || record.line.includes(method.replaceAll('/', '\\/'))
      )
      const message = named && !this.writing.has(key) ? parseObject(record.line) : null
      if (
        message &&
        typeof message.method === 'string' &&
        this.answerItself(message.method, message.id)
      ) {
        this.release(key)
      }
    }
  }

  /** The answers reached the agent's stdin; a request re-sent under the same id since then stays held. */
  releaseAnswered(answered: AnsweredRequest[]): void {
    for (const { key, record } of answered) {
      if (this.writing.get(key) === record) {
        this.writing.delete(key)
      }
      if (this.pending.get(key) === record) {
        this.release(key)
      }
    }
  }

  private observeClientLine(line: string): string | null {
    if (!mayCarryKey(line)) {
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
      const id = rpcId(message.id)
      if (id && this.workMethods.has(message.method) && this.working.size < MAX_PENDING_REQUESTS) {
        this.working.add(id)
      }
      if (message.method === 'initialize' && this.initializeKey === null) {
        this.initializeKey = rpcId(message.id)
      }
      this.kept.observeRequest(id, message.id, message.method, line)
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
