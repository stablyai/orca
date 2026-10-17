import { DAP_ADAPTERS, type DapAdapterRow } from './dap-adapter-registry'
import type { DapConnection } from './dap-connection'
import {
  OutputRing,
  readOutputEvent,
  readStoppedEvent,
  readValueDetails,
  responseBody,
  responseList,
  truncateOutput,
  type BreakpointEventBody,
  type Capabilities,
  type Event,
  type Response,
  type Scope,
  type StackFrame,
  type Thread,
  type Variable
} from './dap-protocol'
import { normalizeDebugPath, type DebugBreakpointStore } from './debug-breakpoint-store'
import { SessionBreakpointSender, type SessionBreakpointStatus } from './debug-session-breakpoints'
import {
  runDebugHandshake,
  stopDebugConnections,
  type DebugAdapterCommand,
  type DebugConnectionRole,
  type DebugOutputEntry,
  type DebugRequestTarget,
  type DebugSessionState,
  type EvaluateContext,
  type EvaluateResult,
  type StackTrace,
  type HandshakeInput
} from './debug-session-handshake'
import type { LaunchSpec } from './launch-config'

export const DEBUG_OUTPUT_RING_ENTRIES = 2000
export type { DebugSessionState, DebugSessionStatus } from './debug-session-handshake'

export type DebugSessionOptions = {
  spec: LaunchSpec
  command: DebugAdapterCommand
  worktreeRoot: string
  breakpoints: DebugBreakpointStore
  /** Defaults to the registry row named by spec.adapterId. */
  row?: DapAdapterRow
  /** The filters the user enabled; unset means the adapter's `default: true` filters. */
  exceptionFilters?: string[]
  log?: (line: string) => void
  connectionOptions?: HandshakeInput['connectionOptions']
  startTimeoutMs?: number
}

/** One debug session: a root connection, plus js-debug's child leaf that debugs the program. */
export class DebugSession {
  private readonly row: DapAdapterRow
  private readonly root: string
  private readonly log: (line: string) => void
  private readonly listeners = new Set<(state: DebugSessionState) => void>()
  /** Debuggee output; the service reads it by `total` and frees it after a finished session. */
  readonly outputRing = new OutputRing<DebugOutputEntry>(DEBUG_OUTPUT_RING_ENTRIES, (entry) =>
    Buffer.byteLength(entry.output)
  )
  private current: DebugSessionState = { status: 'starting' }
  private rootConnection: DapConnection | null = null
  private leaf: DapConnection | null = null
  private caps: Capabilities = {}
  private readonly bps: SessionBreakpointSender
  private configured = false
  private ended: Promise<void> | null = null
  private readonly offStore: () => void

  constructor(private readonly options: DebugSessionOptions) {
    const row = options.row ?? DAP_ADAPTERS.find((r) => r.id === options.spec.adapterId)
    if (!row) {
      throw new Error(`no debug adapter "${options.spec.adapterId}"`)
    }
    this.row = row
    this.root = normalizeDebugPath(options.worktreeRoot)
    this.log = options.log ?? ((line) => console.warn(`[debug] ${line}`))
    this.bps = new SessionBreakpointSender(
      options.breakpoints,
      this.root,
      row.breakpointsBindLazily,
      options.exceptionFilters
    )
    this.offStore = this.bps.watch(
      () => (this.leaf && this.configured && this.isLive() ? this.leaf : null),
      () => this.caps,
      this.log
    )
  }

  get state(): DebugSessionState {
    return { ...this.current }
  }

  get capabilities(): Capabilities {
    return { ...this.caps }
  }

  output(): DebugOutputEntry[] {
    return this.outputRing.all()
  }

  /** SIGKILLs every adapter process group now; for app quit, where nothing async runs. */
  killSync(): void {
    this.leaf?.killSync()
    this.rootConnection?.killSync()
  }

  breakpointStatus(file: string): SessionBreakpointStatus[] {
    return this.bps.answers.status(normalizeDebugPath(file))
  }

  onStateChange(listener: (state: DebugSessionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.setState({ status: 'starting' })
    try {
      await runDebugHandshake({
        row: this.row,
        command: this.options.command,
        spec: this.options.spec,
        attach: (connection, role) => this.attach(connection, role),
        configureLeaf: (connection, caps) => this.configureLeaf(connection, caps),
        configureCoordinator: (connection, caps) => this.bps.sendExceptionFilters(connection, caps),
        log: this.log,
        connectionOptions: this.options.connectionOptions,
        startTimeoutMs: this.options.startTimeoutMs
      })
      if (this.current.status === 'starting') {
        this.setState({ status: 'running' })
      }
    } catch (error) {
      await stopDebugConnections([this.leaf, this.rootConnection], {
        attach: this.options.spec.request === 'attach',
        terminate: false
      })
      // A program that ran to completion during the handshake is a finished session, not a failure.
      if (this.current.status === 'terminated') {
        return
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.setState({ status: 'failed', reason })
      throw error
    }
  }

  async threads(): Promise<Thread[]> {
    return responseList<Thread>(responseBody(await this.request('threads')).threads)
  }

  async stackTrace(threadId: number, startFrame?: number, levels?: number): Promise<StackTrace> {
    const body = responseBody(await this.request('stackTrace', { threadId, startFrame, levels }))
    const total = typeof body.totalFrames === 'number' ? { totalFrames: body.totalFrames } : {}
    return { stackFrames: responseList<StackFrame>(body.stackFrames), ...total }
  }

  async scopes(frameId: number): Promise<Scope[]> {
    return responseList<Scope>(responseBody(await this.request('scopes', { frameId })).scopes)
  }

  /** start/count are sent only to an adapter that claims variable paging. */
  async variables(variablesReference: number, start?: number, count?: number): Promise<Variable[]> {
    const paging = this.caps.supportsVariablePaging ? { start, count } : {}
    const response = await this.request('variables', { variablesReference, ...paging })
    return responseList<Variable>(responseBody(response).variables)
  }

  /** frameId 0 is js-debug's innermost frame, so only `undefined` means "no frame". */
  async evaluate(
    expression: string,
    frameId?: number,
    context: EvaluateContext = 'repl'
  ): Promise<EvaluateResult> {
    const frame = frameId === undefined ? {} : { frameId }
    const body = responseBody(await this.request('evaluate', { expression, context, ...frame }))
    return { result: String(body.result ?? ''), ...readValueDetails(body) }
  }

  async setVariable(variablesReference: number, name: string, value: string): Promise<Variable> {
    if (!this.caps.supportsSetVariable) {
      throw new Error('setting a variable is unsupported by this debugger')
    }
    const body = responseBody(
      await this.request('setVariable', { variablesReference, name, value })
    )
    return { name, value: String(body.value ?? value), ...readValueDetails(body) }
  }

  readonly continue = (threadId: number): Promise<void> => this.resume('continue', threadId)
  readonly next = (threadId: number): Promise<void> => this.resume('next', threadId)
  readonly stepIn = (threadId: number): Promise<void> => this.resume('stepIn', threadId)
  readonly stepOut = (threadId: number): Promise<void> => this.resume('stepOut', threadId)

  async pause(threadId: number): Promise<void> {
    await this.request('pause', { threadId })
  }

  /** Sent to the leaf (or `root`); for tests and adapter-specific requests. */
  customRequest(command: string, args?: unknown, target?: DebugRequestTarget): Promise<Response> {
    return this.request(command, args, target)
  }

  async setExceptionFilters(filters: string[]): Promise<void> {
    this.bps.exceptionFilters = [...filters]
    if (this.leaf && this.configured && this.isLive()) {
      await this.bps.sendExceptionFilters(this.leaf, this.caps)
    }
  }

  /** The restart request when supported, else stop and a fresh start from the same LaunchSpec. */
  async restart(): Promise<void> {
    if (this.caps.supportsRestartRequest && this.leaf && this.isLive()) {
      await this.request('restart', { arguments: this.options.spec.config })
      return
    }
    await this.stop()
    this.ended = null
    this.configured = false
    this.caps = {}
    this.bps.reset()
    await this.start()
  }

  /** terminate when supported (never for attach), then disconnect, then the bounded close. */
  async stop(): Promise<void> {
    if (!this.ended) {
      this.ended = this.shutdown(true)
    }
    await this.ended
  }

  dispose(): Promise<void> {
    this.offStore()
    return this.stop()
  }

  private async shutdown(terminate: boolean): Promise<void> {
    await stopDebugConnections([this.leaf, this.rootConnection], {
      attach: this.options.spec.request === 'attach',
      terminate: terminate && this.caps.supportsTerminateRequest === true
    })
    if (this.current.status !== 'terminated' && this.current.status !== 'failed') {
      this.setState({ status: 'terminated', reason: 'stopped' })
    }
  }

  private isLive(): boolean {
    return this.current.status === 'running' || this.current.status === 'stopped'
  }

  private request(command: string, args?: unknown, target?: DebugRequestTarget): Promise<Response> {
    const connection = target === 'root' ? this.rootConnection : this.leaf
    return connection
      ? connection.request(command, args)
      : Promise.reject(new Error(`no live debug session for ${command}`))
  }

  /** Marked running BEFORE the request: the next stopped event can beat its response. */
  private async resume(command: string, threadId: number): Promise<void> {
    const before = this.current
    this.setState({ status: 'running' })
    try {
      await this.request(command, { threadId })
    } catch (error) {
      if (this.current.status === 'running') {
        this.setState(before)
      }
      throw error
    }
  }

  private attach(connection: DapConnection, role: DebugConnectionRole): void {
    if (role === 'root') {
      this.rootConnection = connection
    }
    // Until a child exists the root stands in as leaf, so a single-connection adapter needs no switch.
    if (role === 'child' || !this.row.usesChildSessions) {
      this.leaf = connection
    }
    connection.onEvent((event) => this.onEvent(connection, event))
    connection.onClose((reason) => this.onClose(connection, reason))
  }

  private async configureLeaf(connection: DapConnection, caps: Capabilities): Promise<void> {
    this.caps = { ...caps }
    await this.bps.configure(connection, caps)
    this.configured = true
  }

  private onEvent(connection: DapConnection, event: Event): void {
    const body = typeof event.body === 'object' && event.body !== null ? Object(event.body) : {}
    if (event.event === 'terminated') {
      this.end('the program terminated')
      return
    }
    // Only the leaf's events drive state; a js-debug root's stopped means nothing here.
    if (connection !== this.leaf) {
      return
    }
    if (event.event === 'stopped') {
      this.setState(readStoppedEvent(body))
    } else if (event.event === 'continued' && this.current.status === 'stopped') {
      this.setState({ status: 'running' })
    } else if (event.event === 'output') {
      const { category, output } = readOutputEvent(body)
      this.outputRing.push({ category, output: truncateOutput(output) })
    } else if (event.event === 'breakpoint') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the breakpoint event body; applyEvent checks the breakpoint id.
      this.bps.answers.applyEvent(body as BreakpointEventBody)
    } else if (event.event === 'capabilities' && typeof body.capabilities === 'object') {
      this.caps = { ...this.caps, ...body.capabilities }
    }
  }

  private onClose(connection: DapConnection, reason: string): void {
    if (this.ended || !this.isLive()) {
      return
    }
    // A js-debug child is a socket dial with no stderr of its own; the root's process wrote it.
    const stderr = connection.stderr.trim() || this.rootConnection?.stderr.trim() || ''
    const tail = stderr.slice(-1024)
    this.end(tail && !reason.includes(tail) ? `${reason}: ${tail}` : reason)
  }

  /** A terminated session still owns an adapter process, so it is shut down here too. */
  private end(reason: string): void {
    if (this.current.status === 'terminated' || this.current.status === 'failed') {
      return
    }
    this.setState({ status: 'terminated', reason })
    this.ended ??= this.shutdown(false)
  }

  private setState(state: DebugSessionState): void {
    this.current = state
    for (const listener of this.listeners) {
      try {
        listener({ ...state })
      } catch (error) {
        this.log(`state listener threw: ${String(error)}`)
      }
    }
  }
}
