// ACP client over stdio: spawns an agent that serves the Agent Client Protocol
// (`hermes acp`, `omp acp`), performs the initialize handshake, opens a session,
// and routes incoming traffic to callbacks.
//
// Why a client and not a library: `agent-client-protocol` ships a Python and a
// Rust implementation; the TypeScript side of what we need is one JSON-RPC pipe
// with four inbound cases (response, session/update notification, permission
// request, everything else). Wiring that directly keeps the dependency surface
// at zero and the failure path short.
//
// The transport is injectable (`spawn` option) so the request/response
// correlation, permission routing, and teardown are unit-testable without
// starting a real agent.

import { spawn as nodeSpawn, execFile } from 'node:child_process'
import {
  createAcpLineDecoder,
  encodeAcpMessage,
  type JsonRpcMessage
} from './acp-jsonrpc-framing'
import { buildAcpPermissionOutcome, type AcpPermissionRequestParams } from './acp-permission-bridge'

/** ACP protocol version this client implements. Both `hermes acp` and `omp acp`
 *  report v1; the agent echoes its own version in the initialize result and we
 *  surface a mismatch rather than guessing at compatibility. */
export const ACP_CLIENT_PROTOCOL_VERSION = 1

export const ACP_REQUEST_TIMEOUT_MS = 60_000
/** Startup is slower than a steady-state request: the agent loads config and
 *  registers MCP servers before answering initialize (observed ~8s locally with
 *  two MCP servers and 51 tools). */
export const ACP_INITIALIZE_TIMEOUT_MS = 120_000
const TERMINATE_GRACE_MS = 2_000

export type AcpSpawnOptions = {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

/** Minimal surface the client needs from a child process, so tests can supply a
 *  fake without constructing a real ChildProcess. */
export type AcpChildLike = {
  pid?: number
  stdin: { write: (chunk: string) => unknown; end?: () => unknown } | null
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown } | null
  stderr: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown } | null
  on: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => unknown
  kill?: (signal?: NodeJS.Signals) => unknown
}

export type AcpClientOptions = AcpSpawnOptions & {
  /** Called for every `session/update` notification. */
  onSessionUpdate: (update: Record<string, unknown>, sessionId: string | null) => void
  /**
   * Called when the agent requests permission to run a tool. Must resolve to the
   * chosen ACP optionId, or null to cancel.
   *
   * There is no default grant: if this is absent the client cancels every
   * request, because an unanswered permission must never become an implicit
   * allow (see acp-permission-bridge).
   */
  onPermissionRequest?: (params: AcpPermissionRequestParams) => Promise<string | null>
  /** Agent stderr and transport diagnostics. ACP reserves stdout for JSON-RPC,
   *  so stderr is where an agent reports its own startup and errors. */
  onLog?: (line: string) => void
  /** Called once when the agent process exits, expectedly or not. */
  onExit?: (code: number | null, signal: string | null) => void
  spawn?: (options: AcpSpawnOptions) => AcpChildLike
}

export type AcpInitializeResult = {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: Record<string, unknown>
  authMethods?: unknown[]
}

export type AcpClient = {
  initialize: () => Promise<AcpInitializeResult>
  newSession: (args?: { cwd?: string; mcpServers?: unknown[] }) => Promise<string>
  loadSession: (sessionId: string, args?: { cwd?: string }) => Promise<void>
  prompt: (sessionId: string, blocks: unknown[]) => Promise<Record<string, unknown>>
  cancel: (sessionId: string) => void
  request: (method: string, params?: unknown) => Promise<unknown>
  dispose: () => void
  readonly disposed: boolean
}

class AcpTransportError extends Error {}

function defaultSpawn(options: AcpSpawnOptions): AcpChildLike {
  return nodeSpawn(options.command, options.args, {
    cwd: options.cwd,
    // ACP is stdin/stdout JSON-RPC with diagnostics on stderr.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env }
  }) as unknown as AcpChildLike
}

/** Mirrors relay/subprocess-tree-termination.ts. Duplicated rather than imported
 *  because src/main does not take value imports from src/relay (only types). */
function terminateTree(child: AcpChildLike): void {
  const pid = child.pid
  if (pid == null) {
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
      // Best-effort; the exit listener owns completion.
    })
    return
  }
  try {
    child.kill?.('SIGKILL')
  } catch {
    // Child may already have exited between the kill request and now.
  }
}

export function createAcpStdioClient(options: AcpClientOptions): AcpClient {
  const spawnFn = options.spawn ?? defaultSpawn
  const child = spawnFn({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env
  })

  let nextId = 1
  let disposed = false
  const pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  const decoder = createAcpLineDecoder((line, error) => {
    options.onLog?.(`acp: dropped malformed frame (${String(error)}): ${line.slice(0, 200)}`)
  })

  function send(message: JsonRpcMessage): void {
    if (disposed || child.stdin == null) {
      return
    }
    try {
      child.stdin.write(encodeAcpMessage(message))
    } catch (error) {
      options.onLog?.(`acp: write failed: ${String(error)}`)
    }
  }

  function settleAll(error: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function request(method: string, params?: unknown, timeoutMs = ACP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (disposed) {
      return Promise.reject(new AcpTransportError('ACP client disposed'))
    }
    const id = nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new AcpTransportError(`ACP request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // Why unref: a pending ACP request must not hold the process open during
      // shutdown; dispose() rejects anything still outstanding.
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async function handlePermissionRequest(
    id: string | number,
    params: AcpPermissionRequestParams
  ): Promise<void> {
    let optionId: string | null = null
    if (options.onPermissionRequest) {
      try {
        optionId = await options.onPermissionRequest(params)
      } catch (error) {
        options.onLog?.(`acp: permission handler failed, cancelling: ${String(error)}`)
        optionId = null
      }
    } else {
      options.onLog?.('acp: no permission handler installed, cancelling request')
    }
    send({ jsonrpc: '2.0', id, result: buildAcpPermissionOutcome(optionId) })
  }

  function handleInbound(message: JsonRpcMessage): void {
    // A response carries an id and no method.
    if (message.method == null && message.id != null) {
      const entry = pending.get(message.id)
      if (entry == null) {
        return
      }
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new AcpTransportError(`${message.error.message} (${message.error.code})`))
        return
      }
      entry.resolve(message.result)
      return
    }

    if (message.method == null) {
      return
    }

    // Notification: no id to answer.
    if (message.method === 'session/update') {
      const params = (message.params ?? {}) as Record<string, unknown>
      const update = params.update
      if (update != null && typeof update === 'object') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
        options.onSessionUpdate(update as Record<string, unknown>, sessionId)
      }
      return
    }

    // Agent → client requests. Anything with an id must be answered or the
    // agent's turn stalls waiting on us.
    if (message.id != null) {
      if (message.method === 'session/request_permission') {
        void handlePermissionRequest(message.id, (message.params ?? {}) as AcpPermissionRequestParams)
        return
      }
      // We advertise no fs capability, so an fs/* call is a protocol error on
      // the agent's side; answer method-not-found rather than leaving it hung.
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not supported by Orca: ${message.method}` }
      })
    }
  }

  child.stdout?.on('data', (chunk) => {
    for (const message of decoder.push(chunk.toString())) {
      try {
        handleInbound(message)
      } catch (error) {
        options.onLog?.(`acp: inbound handler failed: ${String(error)}`)
      }
    }
  })

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) {
        options.onLog?.(line)
      }
    }
  })

  child.on('exit', (...args: unknown[]) => {
    const code = typeof args[0] === 'number' ? args[0] : null
    const signal = typeof args[1] === 'string' ? args[1] : null
    disposed = true
    settleAll(new AcpTransportError(`ACP agent exited (code ${String(code)}, signal ${String(signal)})`))
    options.onExit?.(code, signal)
  })

  child.on('error', (...args: unknown[]) => {
    const error = args[0]
    options.onLog?.(`acp: spawn error: ${String(error)}`)
    disposed = true
    settleAll(new AcpTransportError(`ACP agent failed to start: ${String(error)}`))
  })

  return {
    async initialize(): Promise<AcpInitializeResult> {
      const result = (await request(
        'initialize',
        {
          protocolVersion: ACP_CLIENT_PROTOCOL_VERSION,
          // Orca renders the conversation; it does not lend the agent its own
          // filesystem. Both target agents read files through their own tools.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        },
        ACP_INITIALIZE_TIMEOUT_MS
      )) as AcpInitializeResult
      const version = result?.protocolVersion
      if (typeof version === 'number' && version !== ACP_CLIENT_PROTOCOL_VERSION) {
        options.onLog?.(
          `acp: agent reports protocol v${version}, client implements v${ACP_CLIENT_PROTOCOL_VERSION}`
        )
      }
      return result
    },

    async newSession(args = {}): Promise<string> {
      const result = (await request('session/new', {
        cwd: args.cwd ?? options.cwd ?? process.cwd(),
        mcpServers: args.mcpServers ?? []
      })) as { sessionId?: unknown }
      const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : null
      if (sessionId == null) {
        throw new AcpTransportError('ACP session/new returned no sessionId')
      }
      return sessionId
    },

    async loadSession(sessionId, args = {}): Promise<void> {
      await request('session/load', {
        sessionId,
        cwd: args.cwd ?? options.cwd ?? process.cwd(),
        mcpServers: []
      })
    },

    async prompt(sessionId, blocks): Promise<Record<string, unknown>> {
      const result = await request('session/prompt', { sessionId, prompt: blocks })
      return (result ?? {}) as Record<string, unknown>
    },

    cancel(sessionId): void {
      // Cancellation is a notification: there is no reply to await, and the
      // agent reports the interruption through session/update.
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    },

    request(method, params) {
      return request(method, params)
    },

    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      settleAll(new AcpTransportError('ACP client disposed'))
      try {
        child.stdin?.end?.()
      } catch {
        // Already closed.
      }
      // Closing stdin is the protocol-clean shutdown; both target agents exit on
      // EOF. Escalate to a tree kill if the process outlives the grace window so
      // a stuck agent cannot survive the chat view being closed.
      const timer = setTimeout(() => terminateTree(child), TERMINATE_GRACE_MS)
      timer.unref?.()
    },

    get disposed(): boolean {
      return disposed
    }
  }
}
