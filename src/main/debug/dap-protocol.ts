// Hand-written subset of the Debug Adapter Protocol this program speaks.
// Why not @vscode/debugprotocol: a dependency for types alone, and most of it is unused here.

export type ProtocolMessage = {
  seq: number
  type: 'request' | 'response' | 'event'
}

export type Request<TArgs = unknown> = ProtocolMessage & {
  type: 'request'
  command: string
  arguments?: TArgs
}

export type Response<TBody = unknown> = ProtocolMessage & {
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  /** Set when `success` is false; 'cancelled' and 'notStopped' are the spec's own values. */
  message?: string
  body?: TBody
}

export type Event<TBody = unknown> = ProtocolMessage & {
  type: 'event'
  event: string
  body?: TBody
}

export type DapMessage = Request | Response | Event

export type ExceptionBreakpointsFilter = {
  filter: string
  label: string
  description?: string
  default?: boolean
  supportsCondition?: boolean
}

export type Capabilities = {
  supportsConfigurationDoneRequest?: boolean
  supportsConditionalBreakpoints?: boolean
  supportsHitConditionalBreakpoints?: boolean
  supportsLogPoints?: boolean
  supportsEvaluateForHovers?: boolean
  supportsSetVariable?: boolean
  supportsRestartRequest?: boolean
  /** Not `supportTerminateDebuggee` (no "s"): that one is a disconnect argument, not this request. */
  supportsTerminateRequest?: boolean
  supportsFunctionBreakpoints?: boolean
  supportsVariablePaging?: boolean
  exceptionBreakpointFilters?: ExceptionBreakpointsFilter[]
}

export type Source = {
  name?: string
  path?: string
  sourceReference?: number
}

export type SourceBreakpoint = {
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export type Breakpoint = {
  id?: number
  verified: boolean
  /** js-debug answers every bind with verified:false and 'breakpoint.provisionalBreakpoint', then hits. */
  message?: string
  source?: Source
  /** Absent on an unverified breakpoint; may differ from the requested line when verified. */
  line?: number
  column?: number
}

export type Thread = { id: number; name: string }

export type StackFrame = {
  /** js-debug's innermost frame is id 0, so 0 is a valid id and never "no frame". */
  id: number
  name: string
  source?: Source
  line: number
  column: number
  presentationHint?: 'normal' | 'label' | 'subtle'
}

export type Scope = {
  name: string
  presentationHint?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
  expensive: boolean
}

export type Variable = {
  name: string
  value: string
  type?: string
  evaluateName?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
}

export type StoppedEventBody = {
  reason: string
  description?: string
  threadId?: number
  allThreadsStopped?: boolean
  text?: string
  hitBreakpointIds?: number[]
}

export type ContinuedEventBody = {
  threadId: number
  allThreadsContinued?: boolean
}

export type OutputEventBody = {
  /** console, important, stdout, stderr, telemetry, or one the adapter defines. */
  category?: string
  output: string
  source?: Source
  line?: number
}

export type BreakpointEventBody = {
  /** changed, new, removed, or one the adapter defines. */
  reason: string
  breakpoint: Breakpoint
}

export type TerminatedEventBody = { restart?: unknown } | undefined

export type ExitedEventBody = { exitCode: number }

export type ThreadEventBody = {
  /** started, exited, or one the adapter defines. */
  reason: string
  threadId: number
}

/** The `initialized` event carries no body. */
export type InitializedEventBody = undefined

/** A reverse request js-debug sends to open the child session that actually debugs the program. */
export type StartDebuggingRequestArguments = {
  request: 'launch' | 'attach'
  configuration: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A parsed frame as a typed message, or why its envelope is not a DAP message. */
export function readDapMessage(value: unknown): DapMessage | { invalid: string } {
  if (!isRecord(value) || typeof value.seq !== 'number') {
    return { invalid: 'a frame that is not a DAP message' }
  }
  const { seq } = value
  if (value.type === 'response') {
    if (typeof value.request_seq !== 'number' || typeof value.command !== 'string') {
      return { invalid: 'a response without request_seq or command' }
    }
    return {
      seq,
      type: 'response',
      request_seq: value.request_seq,
      success: value.success === true,
      command: value.command,
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
      ...('body' in value ? { body: value.body } : {})
    }
  }
  if (value.type === 'event') {
    return typeof value.event === 'string'
      ? { seq, type: 'event', event: value.event, body: value.body }
      : { invalid: 'an event without an event name' }
  }
  if (value.type === 'request') {
    return typeof value.command === 'string'
      ? { seq, type: 'request', command: value.command, arguments: value.arguments }
      : { invalid: 'a request without a command' }
  }
  return { invalid: `a message of unknown type ${JSON.stringify(value.type)}` }
}

export function responseBody(response: Response): Record<string, unknown> {
  return isRecord(response.body) ? Object(response.body) : {}
}

export function responseList<T>(value: unknown): T[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adapter response arrays are typed by the DAP spec for that command.
  return Array.isArray(value) ? (value as T[]) : []
}

export function capabilitiesOf(response: Response): Capabilities {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an initialize body is the adapter's Capabilities object; every field is optional.
  return responseBody(response) as Capabilities
}

/** The session state a leaf's stopped event describes. */
export function readStoppedEvent(body: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stopped event body as the DAP spec defines it; each field is re-read below.
  const stopped = body as StoppedEventBody
  return {
    status: 'stopped' as const,
    stoppedReason: String(stopped.reason ?? 'unknown'),
    ...(stopped.description ? { description: stopped.description } : {}),
    ...(typeof stopped.threadId === 'number' ? { threadId: stopped.threadId } : {}),
    allThreadsStopped: stopped.allThreadsStopped === true
  }
}

export function readOutputEvent(body: Record<string, unknown>): {
  category: string
  output: string
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the output event body; both fields are coerced to strings.
  const output = body as OutputEventBody
  return { category: String(output.category ?? 'console'), output: String(output.output ?? '') }
}

/** The `type` and `variablesReference` an evaluate or setVariable answer carries. */
export function readValueDetails(body: Record<string, unknown>): {
  type?: string
  variablesReference: number
} {
  const type = typeof body.type === 'string' ? { type: body.type } : {}
  return { ...type, variablesReference: Number(body.variablesReference ?? 0) }
}

export const DAP_OUTPUT_ENTRY_MAX_BYTES = 8 * 1024
export const DAP_OUTPUT_RING_MAX_BYTES = 1024 * 1024

/** Caps one output text at 8 KiB, marking how much was cut. */
export function truncateOutput(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= DAP_OUTPUT_ENTRY_MAX_BYTES) {
    return text
  }
  const kept = bytes.subarray(0, DAP_OUTPUT_ENTRY_MAX_BYTES).toString('utf8')
  return `${kept}… [${bytes.length - DAP_OUTPUT_ENTRY_MAX_BYTES} bytes truncated]\n`
}

/** Debuggee output bounded by entry count AND bytes: a program printing megabytes must not grow main. */
export class OutputRing<T> {
  private items: { item: T; bytes: number }[] = []
  private bytes = 0
  /** Entries ever pushed; a reader resumes from the count it last saw. */
  total = 0

  constructor(
    private readonly maxEntries: number,
    private readonly sizeOf: (item: T) => number,
    private readonly onEvict: (item: T) => void = () => {}
  ) {}

  push(item: T): void {
    const bytes = this.sizeOf(item)
    this.items.push({ item, bytes })
    this.bytes += bytes
    this.total++
    while (
      this.items.length > this.maxEntries ||
      (this.bytes > DAP_OUTPUT_RING_MAX_BYTES && this.items.length > 1)
    ) {
      const evicted = this.items.shift()!
      this.bytes -= evicted.bytes
      this.onEvict(evicted.item)
    }
  }

  get byteSize(): number {
    return this.bytes
  }

  /** The entries pushed after the reader's `total`, as far as the ring still holds them. */
  since(total: number): T[] {
    const fresh = Math.min(this.items.length, Math.max(0, this.total - total))
    return this.items.slice(this.items.length - fresh).map((entry) => entry.item)
  }

  all(): T[] {
    return this.items.map((entry) => entry.item)
  }

  clear(): void {
    this.items = []
    this.bytes = 0
  }
}

/** Delivers queued items as one batch, at most once per `ms`. */
export class Batcher<T> {
  readonly listeners = new Set<(batch: T[]) => void>()
  private queue: T[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ms: number) {}

  push(item: T): void {
    this.queue.push(item)
    this.timer ??= setTimeout(() => {
      this.timer = null
      const batch = this.queue.splice(0)
      this.listeners.forEach((listener) => listener(batch))
    }, this.ms)
  }
}

export const DAP_STDERR_RING_BYTES = 64 * 1024

/** Keeps the last `capacity` bytes of an adapter's stderr for error messages. */
export class StderrRing {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly capacity = DAP_STDERR_RING_BYTES) {}

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.buffer, chunk])
    this.buffer = joined.length > this.capacity ? joined.subarray(-this.capacity) : joined
  }

  text(): string {
    return this.buffer.toString('utf8')
  }
}

/** A stored breakpoint as setBreakpoints carries it; empty strings are not sent. */
export function toSourceBreakpoint(entry: SourceBreakpoint): SourceBreakpoint {
  return {
    line: entry.line,
    ...(entry.column === undefined ? {} : { column: entry.column }),
    ...(entry.condition ? { condition: entry.condition } : {}),
    ...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
    ...(entry.logMessage ? { logMessage: entry.logMessage } : {})
  }
}
