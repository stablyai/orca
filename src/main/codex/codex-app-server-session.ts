import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { waitForProcessExitUntil } from './codex-process-exit-deadline'
import { stderrIndicatesMissingAppServer } from './codex-app-server-capability-signal'

// Why: `codex app-server` is Orca's sanctioned RPC surface into Codex-owned
// state (hook trust hashes, the sqlite thread index). This module owns the
// stdio JSONL transport — spawn, handshake, framing, deadline, reap — so every
// RPC consumer (trust grant, session index heal) shares one hardened lifecycle.

export type CodexAppServerInvocation = {
  command: string
  args: string[]
  /** Overlay applied on top of the inherited environment (e.g. CODEX_HOME). */
  env?: Record<string, string>
  /** Env keys stripped from the inherited environment before spawn (e.g. an
   *  inherited CODEX_HOME, so a default-home grant runs against the real ~/.codex). */
  envToDelete?: readonly string[]
  /** Whole-session deadline. The codex child is SIGKILLed when it lapses. */
  timeoutMs: number
}

/** Codex-side absence of the requested app-server RPC surface (old CLI without
 *  the app-server subcommand, or a server without the called methods).
 *  This is the ONLY error class capability caches mark unsupported. */
export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerUnsupportedError'
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerTimeoutError'
  }
}

export function isCodexAppServerUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CodexAppServerUnsupportedError'
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export type CodexAppServerRpc = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
}

const JSON_RPC_METHOD_NOT_FOUND = -32601
const STDERR_TAIL_MAX_BYTES = 8192
const STDOUT_LINE_MAX_BYTES = 1024 * 1024

export function killCodexAppServerProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {}
): void {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  if (platform === 'win32' && child.pid) {
    try {
      // Why: npm-installed Codex runs behind cmd.exe; killing only that wrapper
      // leaves the app-server child alive after a timeout or failed shutdown.
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      let fellBack = false
      const killDirectChild = (): void => {
        if (!fellBack) {
          fellBack = true
          child.kill('SIGKILL')
        }
      }
      killer.on('error', killDirectChild)
      killer.on('exit', (code) => {
        if (code !== 0) {
          killDirectChild()
        }
      })
      killer.unref()
      return
    } catch {
      // Fall through to the direct-child best effort when taskkill cannot start.
    }
  }
  child.kill('SIGKILL')
}

function isMethodNotFoundError(error: { code?: number; message?: string }): boolean {
  return error.code === JSON_RPC_METHOD_NOT_FOUND || /method not found/i.test(error.message ?? '')
}

/**
 * Runs one short-lived `codex app-server` session over stdio JSON-RPC (JSONL):
 * spawn → initialize → initialized → body(rpc) → EOF/reap. The child is reaped
 * on every path; the session deadline SIGKILLs it.
 */
export async function runCodexAppServerSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
  spawnImpl: typeof spawn = spawn
): Promise<T> {
  // Why: a default-home grant must run against the real ~/.codex, so strip an
  // inherited CODEX_HOME (envToDelete) after applying the overlay, not before.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...invocation.env }
  for (const key of invocation.envToDelete ?? []) {
    delete childEnv[key]
  }
  const child = spawnImpl(invocation.command, invocation.args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as ChildProcessWithoutNullStreams

  let stderrTail = ''
  let exited = false
  let nextRequestId = 1
  let timedOut = false
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >()

  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', () => {
      exited = true
      resolve()
    })
  })
  // Why: 'error' fires instead of 'exit' when the spawn itself fails
  // (ENOENT); surface it to every in-flight request or they wait forever.
  let spawnError: Error | null = null
  child.on('error', (error) => {
    spawnError = error
    exited = true
    failPending(error)
  })
  // Why: 'close' (not 'exit') guarantees the stderr tail is complete, so an
  // early death classifies correctly as missing-subcommand vs transient.
  child.on('close', () => {
    failPending(buildEarlyExitError())
  })
  // Why: JSONL can contain non-ASCII hook paths. Stream decoding must retain a
  // multibyte character split across pipe chunks or the response becomes invalid JSON.
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
  })
  // Why: a child can exit between the liveness check and stdin.write(); an
  // EPIPE must reject the RPC instead of becoming an unhandled stream error.
  child.stdin.on('error', (error) => {
    failPending(error)
  })

  let stdoutBuffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdoutBuffer += chunk
    if (Buffer.byteLength(stdoutBuffer) > STDOUT_LINE_MAX_BYTES) {
      // Why: Windows process-tree termination is asynchronous; stop buffered
      // chunks from spawning another taskkill for the same oversized response.
      child.stdout.destroy()
      killCodexAppServerProcessTree(child)
      failPending(new Error('codex app-server emitted an oversized JSONL response'))
      return
    }
    let newlineIndex
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }
      let message: JsonRpcResponse
      try {
        message = JSON.parse(line) as JsonRpcResponse
      } catch {
        continue
      }
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const waiter = pending.get(message.id)!
        pending.delete(message.id)
        waiter.resolve(message)
      }
    }
  })

  function failPending(error: Error): void {
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }

  let rejectDeadline: (error: Error) => void = () => {}
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const deadline = setTimeout(() => {
    timedOut = true
    const error = new CodexAppServerTimeoutError(
      `codex app-server session exceeded ${invocation.timeoutMs}ms (${invocation.command})`
    )
    killCodexAppServerProcessTree(child)
    failPending(error)
    rejectDeadline(error)
  }, invocation.timeoutMs)

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { method }
    if (params !== undefined) {
      payload.params = params
    }
    try {
      sendLine(payload)
    } catch {
      // Notifications are fire-and-forget; a dead child fails the next request.
    }
  }

  async function requestRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (spawnError) {
      throw spawnError
    }
    if (timedOut) {
      throw new CodexAppServerTimeoutError('codex app-server session already timed out')
    }
    if (exited) {
      throw buildEarlyExitError()
    }
    const id = nextRequestId++
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const payload: Record<string, unknown> = { method, id }
      if (params !== undefined) {
        payload.params = params
      }
      try {
        sendLine(payload)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (response.error) {
      if (isMethodNotFoundError(response.error)) {
        throw new CodexAppServerUnsupportedError(
          `codex app-server does not support ${method}: ${response.error.message ?? 'method not found'}`
        )
      }
      throw new Error(
        `codex app-server ${method} failed: ${response.error.message ?? 'unknown error'}`
      )
    }
    return response.result
  }

  function buildEarlyExitError(): Error {
    if (stderrIndicatesMissingAppServer(stderrTail)) {
      return new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrTail.trim().slice(0, 400)}`
      )
    }
    return new Error(
      `codex app-server exited before completing the session${stderrTail ? `: ${stderrTail.trim().slice(0, 400)}` : ''}`
    )
  }

  try {
    const session = async (): Promise<T> => {
      await requestRpc('initialize', {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
      })
      notify('initialized')
      return body({ request: requestRpc, notify })
    }
    // Why: the timeout owns the whole callback, including time between RPCs;
    // killing the child alone cannot settle a callback awaiting unrelated work.
    return await Promise.race([session(), deadlinePromise])
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof CodexAppServerUnsupportedError) &&
      !(error instanceof CodexAppServerTimeoutError) &&
      stderrIndicatesMissingAppServer(stderrTail)
    ) {
      throw new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrTail.trim().slice(0, 400)}`
      )
    }
    throw error
  } finally {
    try {
      child.stdin.end()
    } catch {
      // stdin may already be destroyed after a kill; reaping below still runs.
    }
    if (!exited) {
      // Why: the server exits promptly on stdin EOF; the grace period only
      // bounds a wedged child before the guaranteed SIGKILL reap.
      await waitForProcessExitUntil(exitPromise, 1500)
      if (!exited) {
        killCodexAppServerProcessTree(child)
        await waitForProcessExitUntil(exitPromise, 1000)
      }
    }
    clearTimeout(deadline)
  }
}
