import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import {
  CodexAppServerTimeoutError,
  isCodexAppServerUnsupportedError
} from './codex-app-server-session'
import type { CodexTerminalStopSupport } from './codex-background-task-tracker'
import { readRecord } from './codex-item-field-readers'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

type CodexTerminalRpc = Pick<CodexAppServerConnection, 'request'>

export type CodexBackgroundTerminal = { threadId: string; processId: string }

// Bound unanswered stops so other session actions can proceed.
const CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS = 10_000
const MAX_LIST_PAGES = 32

export function boundedTimeout(timeoutMs: number | undefined): number {
  return Math.min(
    timeoutMs ?? CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS,
    CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS
  )
}

function refusesMethod(error: unknown): boolean {
  return (
    isCodexAppServerUnsupportedError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes('unknown variant'))
  )
}

/** Refusals/malformed lists mean unsupported; timeouts and dropped requests leave support unknown. */
export async function probeCodexBackgroundTerminals(
  rpc: CodexTerminalRpc,
  threadId: string,
  timeoutMs: number | undefined
): Promise<CodexTerminalStopSupport> {
  try {
    const reply = readRecord(
      await rpc.request(
        'thread/backgroundTerminals/list',
        { threadId, limit: 1 },
        { timeoutMs: boundedTimeout(timeoutMs) }
      )
    )
    return Array.isArray(reply.data) ? 'supported' : 'unsupported'
  } catch (error) {
    return refusesMethod(error) ? 'unsupported' : 'unknown'
  }
}

// Thread unloading ends terminals; losing the connection proves no process exit.
function terminalsAreGone(error: unknown): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.code === -32600 &&
    error.message.includes('failed: thread not found')
  )
}

async function stillRunning(
  rpc: CodexTerminalRpc,
  threadId: string,
  timeoutMs: number
): Promise<Set<string>> {
  const running = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const reply = readRecord(
      await rpc.request(
        'thread/backgroundTerminals/list',
        { threadId, ...(cursor === null ? {} : { cursor }) },
        { timeoutMs }
      )
    )
    for (const terminal of Array.isArray(reply.data) ? reply.data : []) {
      const processId = readRecord(terminal).processId
      if (typeof processId === 'string') {
        running.add(processId)
      }
    }
    cursor = typeof reply.nextCursor === 'string' ? reply.nextCursor : null
    if (cursor === null) {
      return running
    }
  }
  throw new Error('codex app-server listed more background terminals than Orca reads')
}

/** Confirm termination against each thread's list; request failures throw unless a survivor is confirmed. */
export async function terminateCodexBackgroundTerminals(
  rpc: CodexTerminalRpc,
  terminals: readonly CodexBackgroundTerminal[],
  options: { timeoutMs: number | undefined; isCurrent: () => boolean }
): Promise<{ stopped: number; survived: boolean }> {
  const timeoutMs = boundedTimeout(options.timeoutMs)
  let failure: { error: unknown } | undefined
  // An app-server that is not answering would make every later request wait out its own deadline.
  const fail = (error: unknown): boolean => {
    failure ??= { error }
    return error instanceof CodexAppServerTimeoutError
  }
  const unconfirmed = new Map<string, Set<string>>()
  let stopped = 0
  let survived = false
  let timedOut = false
  for (const { threadId, processId } of terminals) {
    if (timedOut || !options.isCurrent()) {
      break
    }
    try {
      await rpc.request(
        'thread/backgroundTerminals/terminate',
        { threadId, processId },
        { timeoutMs }
      )
      // Confirm via the list even if terminated is false; Codex may no longer hold the process.
      unconfirmed.set(threadId, (unconfirmed.get(threadId) ?? new Set()).add(processId))
    } catch (error) {
      if (terminalsAreGone(error)) {
        stopped += 1
      } else {
        timedOut = fail(error)
      }
    }
  }
  for (const [threadId, processIds] of unconfirmed) {
    if (timedOut) {
      break
    }
    try {
      const running = await stillRunning(rpc, threadId, timeoutMs)
      for (const processId of processIds) {
        if (running.has(processId)) {
          survived = true
        } else {
          stopped += 1
        }
      }
    } catch (error) {
      if (terminalsAreGone(error)) {
        stopped += processIds.size
      } else {
        timedOut = fail(error)
      }
    }
  }
  if (failure && !survived) {
    throw failure.error
  }
  return { stopped, survived }
}

/** Probe outside frame handling; support restates running commands as stoppable. */
export function startCodexTerminalStopProbe(
  sessions: ReadonlyMap<string, CodexSession>,
  sessionId: string,
  session: CodexSession,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>
): void {
  if (!session.backgroundTasks.beginTerminalStopProbe()) {
    return
  }
  void probeCodexBackgroundTerminals(
    session.connection,
    session.threadId,
    deps.requestTimeoutMs
  ).then((support) => {
    if (sessions.get(sessionId) !== session || session.ended) {
      return
    }
    try {
      session.backgroundTasks.settleTerminalStopProbe(support)
      session.backgroundTasks.publishChildWork()
    } catch (error) {
      deps.logger?.warn('Codex background-terminal stops could not be published', {
        scope: 'codex-background-terminals',
        sessionId,
        error
      })
    }
  })
}
