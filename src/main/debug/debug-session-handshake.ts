import type { DapAdapterRow } from './dap-adapter-registry'
import { DapConnection, type DapConnectionOptions } from './dap-connection'
import {
  capabilitiesOf,
  type Capabilities,
  type StackFrame,
  type Request,
  type StartDebuggingRequestArguments
} from './dap-protocol'
import {
  connectSocketAdapter,
  connectTcpAdapter,
  DAP_SOCKET_PLACEHOLDER,
  DLV_READY_PATTERN,
  JS_DEBUG_READY_PATTERN,
  spawnSocketAdapter,
  spawnStdioAdapter,
  spawnTcpAdapter,
  type DapEndpoint,
  type DapTransport
} from './dap-transport'
import type { LaunchSpec } from './launch-config'

export const DEBUG_START_TIMEOUT_MS = 30_000

export type DebugSessionStatus = 'starting' | 'running' | 'stopped' | 'terminated' | 'failed'

export type DebugSessionState = {
  status: DebugSessionStatus
  stoppedReason?: string
  description?: string
  threadId?: number
  allThreadsStopped?: boolean
  /** Why the session ended or failed. */
  reason?: string
}

export type DebugOutputEntry = { category: string; output: string }
export type EvaluateContext = 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables'
export type EvaluateResult = { result: string; type?: string; variablesReference: number }
export type StackTrace = { stackFrames: StackFrame[]; totalFrames?: number }
export type DebugRequestTarget = 'leaf' | 'root'

/**
 * An approved adapter to spawn, or an already-listening adapter server owned elsewhere to dial.
 * No env: a launch config's env reaches only the debuggee, through the launch request.
 */
export type DebugAdapterCommand =
  | { program: string; args: readonly string[]; cwd?: string }
  | DapEndpoint

export type DebugConnectionRole = 'root' | 'child'

export type HandshakeInput = {
  row: DapAdapterRow
  command: DebugAdapterCommand
  spec: LaunchSpec
  /** Called synchronously on each new connection, before any byte is read, to attach listeners. */
  attach: (connection: DapConnection, role: DebugConnectionRole) => void
  /** Sends setBreakpoints for every file and setExceptionBreakpoints on the leaf. */
  configureLeaf: (connection: DapConnection, caps: Capabilities) => Promise<void>
  /** Sends setExceptionBreakpoints on a js-debug root, which gets no breakpoints. */
  configureCoordinator: (connection: DapConnection, caps: Capabilities) => Promise<void>
  log: (line: string) => void
  connectionOptions?: Pick<DapConnectionOptions, 'requestTimeoutMs' | 'closeTimeoutMs'>
  startTimeoutMs?: number
}

export type HandshakeResult = {
  root: DapConnection
  /** The connection that debugs the program: the root, or js-debug's child. */
  leaf: DapConnection
  leafCaps: Capabilities
}

export function initializeArguments(adapterId: string): Record<string, unknown> {
  return {
    clientID: 'orca',
    clientName: 'Orca',
    adapterID: adapterId,
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: true,
    supportsRunInTerminalRequest: false,
    supportsStartDebuggingRequest: true
  }
}

function describeConfiguration(args: StartDebuggingRequestArguments | undefined): string {
  const config = args?.configuration ?? {}
  const name = typeof config.name === 'string' && config.name ? config.name : null
  const type = typeof config.type === 'string' && config.type ? config.type : null
  return name ?? type ?? args?.request ?? 'unnamed'
}

/** One leaf session, enforced out loud: a refusal unblocks the adapter, a drop would not. */
function declineStartDebugging(request: Request, log: (line: string) => void): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only read through describeConfiguration, which checks every field.
  const args = request.arguments as StartDebuggingRequestArguments | undefined
  const what = describeConfiguration(args)
  log(`declined a second debug session (${what}); Orca debugs one session at a time`)
  throw new Error(`Orca debugs one session at a time; declined "${what}"`)
}

const STOP_REQUEST_TIMEOUT_MS = 1000
/** The whole stop, every connection included: polite requests first, then the bounded closes. */
export const DEBUG_STOP_DEADLINE_MS = 2500

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/** terminate when supported (never for attach), disconnect, bounded close; one deadline for all. */
export async function stopDebugConnections(
  connections: readonly (DapConnection | null)[],
  options: { attach: boolean; terminate: boolean }
): Promise<void> {
  const deadline = Date.now() + DEBUG_STOP_DEADLINE_MS
  const live = [...new Set(connections)].filter((c): c is DapConnection => !!c && !c.closed)
  const polite = async (connection: DapConnection): Promise<void> => {
    const ask = (command: string, args?: unknown): Promise<unknown> =>
      connection.request(command, args, { timeoutMs: STOP_REQUEST_TIMEOUT_MS }).catch(() => {})
    if (options.terminate && !options.attach) {
      await ask('terminate')
    }
    await ask('disconnect', { terminateDebuggee: !options.attach })
  }
  await Promise.race([Promise.all(live.map(polite)), sleep(STOP_REQUEST_TIMEOUT_MS)])
  // Leaf first (connections are passed leaf-first); each close kills its own process group.
  const closes = connections.flatMap((c) => (c ? [c.close('debug session ended')] : []))
  await Promise.race([Promise.all(closes), sleep(deadline - Date.now())])
}

function nextEvent(connection: DapConnection, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const offEvent = connection.onEvent((event) => {
      if (event.event === name) {
        offEvent()
        offClose()
        resolve()
      }
    })
    const offClose = connection.onClose((reason) => {
      offEvent()
      reject(new Error(`debug adapter closed before ${name}: ${reason}`))
    })
  })
}

/** Rejects when `promise` does; never resolves otherwise. */
function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function openTransport(
  row: DapAdapterRow,
  command: DebugAdapterCommand
): Promise<DapTransport> {
  if (!('program' in command)) {
    return dial(command)
  }
  const spec = { program: command.program, args: command.args, cwd: command.cwd }
  if (row.transport === 'stdio') {
    return spawnStdioAdapter(spec)
  }
  if (command.args.some((arg) => arg.includes(DAP_SOCKET_PLACEHOLDER))) {
    return spawnSocketAdapter(spec)
  }
  return spawnTcpAdapter(spec, row.id === 'dlv' ? DLV_READY_PATTERN : JS_DEBUG_READY_PATTERN)
}

function dial(endpoint: DapEndpoint): Promise<DapTransport> {
  return 'path' in endpoint ? connectSocketAdapter(endpoint) : connectTcpAdapter(endpoint)
}

/**
 * initialize, then launch/attach WITHOUT awaiting it, configure on `initialized`, configurationDone,
 * and only THEN await the launch answer: debugpy answers launch only after configurationDone.
 */
async function startConnection(
  connection: DapConnection,
  adapterId: string,
  request: string,
  config: Record<string, unknown>,
  configure: (connection: DapConnection, caps: Capabilities) => Promise<void>,
  timeoutMs: number
): Promise<Capabilities> {
  const initialized = nextEvent(connection, 'initialized')
  initialized.catch(() => {})
  const caps = capabilitiesOf(
    await connection.request('initialize', initializeArguments(adapterId))
  )
  const launched = connection.request(request, config)
  launched.catch(() => {})
  await withTimeout(Promise.race([initialized, failureOf(launched)]), timeoutMs, 'initialized')
  await configure(connection, caps)
  if (caps.supportsConfigurationDoneRequest) {
    await connection.request('configurationDone')
  }
  await launched
  return caps
}

export async function runDebugHandshake(input: HandshakeInput): Promise<HandshakeResult> {
  const { row, spec, log } = input
  const timeoutMs = input.startTimeoutMs ?? DEBUG_START_TIMEOUT_MS
  const transport = await openTransport(row, input.command)
  let claimed = false
  let resolveChild!: (args: StartDebuggingRequestArguments) => void
  const childRequested = new Promise<StartDebuggingRequestArguments>((resolve) => {
    resolveChild = resolve
  })
  const root = new DapConnection(transport, {
    ...input.connectionOptions,
    onReverseRequest: (request) => {
      if (request.command !== 'startDebugging' || !row.usesChildSessions) {
        throw new Error(`${request.command} is not supported`)
      }
      if (claimed) {
        declineStartDebugging(request, log)
      }
      claimed = true
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarded verbatim; only `request` and `configuration` are read, both checked below.
      resolveChild(request.arguments as StartDebuggingRequestArguments)
      return {}
    }
  })
  input.attach(root, 'root')
  try {
    if (!row.usesChildSessions) {
      const caps = await startConnection(
        root,
        row.adapterId,
        spec.request,
        spec.config,
        input.configureLeaf,
        timeoutMs
      )
      return { root, leaf: root, leafCaps: caps }
    }
    // The root launches the program only after its own configurationDone, so it cannot wait for the child.
    const rootStarted = startConnection(
      root,
      row.adapterId,
      spec.request,
      spec.config,
      input.configureCoordinator,
      timeoutMs
    )
    rootStarted.catch(() => {})
    const rootClosed = new Promise<never>((_, reject) =>
      root.onClose((reason) => reject(new Error(`debug adapter closed: ${reason}`)))
    )
    rootClosed.catch(() => {})
    const childArgs = await withTimeout(
      Promise.race([childRequested, failureOf(rootStarted), rootClosed]),
      timeoutMs,
      'startDebugging'
    )
    const child = await openChild(root, transport, input, childArgs, timeoutMs)
    await rootStarted
    return child
  } catch (error) {
    await root.close('debug session failed to start')
    throw error
  }
}

async function openChild(
  root: DapConnection,
  rootTransport: DapTransport,
  input: HandshakeInput,
  args: StartDebuggingRequestArguments,
  timeoutMs: number
): Promise<HandshakeResult> {
  if (!rootTransport.endpoint) {
    throw new Error(`${input.row.label}: this adapter's transport cannot carry a child session`)
  }
  // The same socket the root dialed; its 0700 directory is the only way in.
  const transport = await dial(rootTransport.endpoint)
  const leaf = new DapConnection(transport, {
    ...input.connectionOptions,
    // A leaf has no session to give away; a grandchild is refused the same loud way.
    onReverseRequest: (request) =>
      request.command === 'startDebugging'
        ? declineStartDebugging(request, input.log)
        : Promise.reject(new Error(`${request.command} is not supported`))
  })
  input.attach(leaf, 'child')
  try {
    const request = args?.request === 'attach' ? 'attach' : 'launch'
    // Verbatim: {type, name, __pendingTargetId}; re-adding launch keys starts a second copy.
    const configuration = args?.configuration ?? {}
    const leafCaps = await startConnection(
      leaf,
      input.row.adapterId,
      request,
      configuration,
      input.configureLeaf,
      timeoutMs
    )
    return { root, leaf, leafCaps }
  } catch (error) {
    await leaf.close('child debug session failed to start')
    throw error
  }
}
