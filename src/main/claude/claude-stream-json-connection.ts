import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { attachClaudeStreamJsonStdout } from './claude-stream-json-stdout'

export type ClaudeStreamJsonLaunch = {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export type ClaudeControlRequest = {
  type: 'control_request'
  request_id: string
  request: Record<string, unknown> & { subtype: string }
}

export type ClaudeControlCancelRequest = {
  type: 'control_cancel_request'
  request_id: string
}

export type ClaudeControlResponder = Pick<
  ClaudeStreamJsonConnection,
  'respond' | 'respondWithError'
>

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  onControlRequest?: (request: ClaudeControlRequest, responder?: ClaudeControlResponder) => void
  onControlCancelRequest?: (request: ClaudeControlCancelRequest) => void
  onExit?: (error: Error) => void
}

export type ClaudeStreamJsonConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  send: (message: Record<string, unknown>) => Promise<void>
  request: (
    subtype: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
  respond: (requestId: string, response: unknown) => Promise<void>
  respondWithError: (requestId: string, error: string) => Promise<void>
  close: () => Promise<void>
}

export class ClaudeControlRequestError extends Error {
  constructor(
    readonly subtype: string,
    message: string
  ) {
    super(message)
    this.name = 'ClaudeControlRequestError'
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000
const STDERR_TAIL_MAX_BYTES = 8192
const STDOUT_LINE_MAX_BYTES = 8 * 1024 * 1024

type PendingRequest = {
  subtype: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exitError(stderrTail: string, cause?: Error): Error {
  const detail = stderrTail.trim()
  const message = detail ? `claude stream-json exited: ${detail}` : 'claude stream-json exited'
  return cause ? new Error(message, { cause }) : new Error(message)
}
export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: typeof spawn = spawn
): Promise<ClaudeStreamJsonConnection> {
  const child = spawnImpl(launch.command, launch.args, {
    cwd: launch.cwd,
    env: buildClaudeChildProcessEnv(launch.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as ChildProcessWithoutNullStreams
  const pending = new Map<string, PendingRequest>()
  let nextRequestId = 1
  let stderrTail = ''
  let exited = false
  let closing = false
  let terminalError: Error | null = null
  let writeChain: Promise<void> = Promise.resolve()
  let closePromise: Promise<void> | null = null

  let settleExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settleExit = resolve
  })
  const markExited = (): void => {
    exited = true
    settleExit()
  }
  child.on('exit', markExited)

  const failPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  const handleUnexpectedEnd = (cause?: Error): void => {
    if (terminalError) {
      return
    }
    terminalError = exitError(stderrTail, cause)
    failPending(terminalError)
    if (!closing) {
      handlers.onExit?.(terminalError)
    }
  }

  const writeLine = (payload: Record<string, unknown>): Promise<void> => {
    const write = async (): Promise<void> => {
      if (closing || exited || terminalError || child.stdin.destroyed || !child.stdin.writable) {
        throw terminalError ?? new Error('claude stream-json connection is closed')
      }
      const line = `${JSON.stringify(payload)}\n`
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
      })
    }
    const queued = writeChain.then(write)
    writeChain = queued.catch(() => {})
    return queued
  }

  const respond = (requestId: string, response: unknown): Promise<void> =>
    writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })

  const respondWithError = (requestId: string, error: string): Promise<void> =>
    writeLine({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error }
    })

  const dispatchMessage = (message: Record<string, unknown>): void => {
    if (message.type === 'control_response') {
      const response = isRecord(message.response) ? message.response : null
      const requestId = typeof response?.request_id === 'string' ? response.request_id : null
      const waiter = requestId ? pending.get(requestId) : undefined
      if (!waiter || !requestId || !response) {
        handlers.onMessage?.(message)
        return
      }
      pending.delete(requestId)
      clearTimeout(waiter.timer)
      if (response.subtype === 'success') {
        waiter.resolve(response.response)
      } else {
        waiter.reject(
          new ClaudeControlRequestError(
            waiter.subtype,
            typeof response.error === 'string'
              ? response.error
              : `claude ${waiter.subtype} request failed`
          )
        )
      }
      return
    }
    if (
      message.type === 'control_request' &&
      typeof message.request_id === 'string' &&
      isRecord(message.request) &&
      typeof message.request.subtype === 'string'
    ) {
      handlers.onControlRequest?.(message as ClaudeControlRequest, { respond, respondWithError })
      return
    }
    if (message.type === 'control_cancel_request' && typeof message.request_id === 'string') {
      handlers.onControlCancelRequest?.(message as ClaudeControlCancelRequest)
      return
    }
    handlers.onMessage?.(message)
  }
  const stdout = attachClaudeStreamJsonStdout({
    stdout: child.stdout,
    maxLineBytes: STDOUT_LINE_MAX_BYTES,
    onMessage: dispatchMessage,
    onFailure: (error) => {
      killCodexAppServerProcessTree(child)
      handleUnexpectedEnd(error)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
  })
  child.on('error', (error) => {
    markExited()
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    markExited()
    stdout.flush()
    handleUnexpectedEnd()
  })
  child.stdin.on('error', (error) => {
    if (!closing) {
      killCodexAppServerProcessTree(child)
      handleUnexpectedEnd(error)
    }
  })

  const request = (
    subtype: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> => {
    const requestId = `orca-${nextRequestId++}`
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`claude ${subtype} request timed out`))
      }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      timer.unref?.()
      pending.set(requestId, { subtype, resolve, reject, timer })
    })
    void writeLine({
      type: 'control_request',
      request_id: requestId,
      request: { subtype, ...params }
    }).catch((error) => {
      const waiter = pending.get(requestId)
      if (waiter) {
        pending.delete(requestId)
        clearTimeout(waiter.timer)
        waiter.reject(error as Error)
      }
    })
    return promise
  }

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      try {
        child.stdin.end()
      } catch {
        // The reap below still owns the process.
      }
      if (!exited) {
        await waitForProcessExitUntil(exitPromise, GRACEFUL_EXIT_MS)
        if (!exited) {
          killCodexAppServerProcessTree(child)
          await waitForProcessExitUntil(exitPromise, FORCED_EXIT_MS)
        }
      }
      failPending(new Error('claude stream-json connection closed'))
    })()
    return closePromise
  }

  return {
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || exited || terminalError !== null
    },
    send: writeLine,
    request,
    respond,
    respondWithError,
    close
  }
}
