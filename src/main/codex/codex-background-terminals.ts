// Stopping a command Codex left running, by the `processId` on its `commandExecution` item, through
// the app-server's experimental background-terminal methods (Codex 0.140+). Each chat has its own
// app-server, so one probe per app-server answers for the Codex binary on the host that runs it. The
// killed process still ends its item with `item/completed`, which removes the command's record.

import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CodexAppServerTimeoutError,
  isCodexAppServerUnsupportedError
} from './codex-app-server-session'
import type { CodexTerminalStopSupport } from './codex-background-task-tracker'
import { readRecord } from './codex-item-field-readers'
import {
  requireLiveCodexSession,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'

type CodexTerminalRpc = Pick<CodexAppServerConnection, 'request'>

/** One command process a Stop names: the thread that ran it and Codex's id for its process. */
export type CodexBackgroundTerminal = { threadId: string; processId: string }

/** Why bounded: a Stop the app-server never answers must not hold the session's other actions. */
const CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS = 10_000
const MAX_LIST_PAGES = 32

function boundedTimeout(timeoutMs: number | undefined): number {
  return Math.min(
    timeoutMs ?? CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS,
    CODEX_BACKGROUND_TERMINAL_TIMEOUT_MS
  )
}

/** An older Codex refuses the method by name: unknown variant, or method not found. */
function refusesMethod(error: unknown): boolean {
  return (
    isCodexAppServerUnsupportedError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes('unknown variant'))
  )
}

/** Whether this app-server lists background terminals, and so can stop them. Only a refusal or
 *  a malformed answer is no; a timeout or dropped request proves nothing either way. */
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

/** Codex unloaded the thread, which ends its terminals. A connection that dropped is no such
 *  proof: losing contact is never evidence the process ended. */
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

/** Terminates each terminal, then confirms against the thread's own list. Resolves with how many
 *  are gone and whether the list shows one still running; throws when a request failed with no
 *  survivor listed, after trying every other, since the effect is then unknown. */
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
      // Answered either way: `terminated: false` is a process Codex no longer holds, which the
      // list below tells apart from one that survived.
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

/** A backgrounded command stops through its app-server's background terminals, once that
 *  app-server proved it has them; a child thread has no stop here. */
export function codexBackgroundTaskStops(
  session: CodexSession | undefined
): AgentSessionBackgroundTaskStops | undefined {
  const stops = session?.backgroundTasks.stopsTerminals
  return stops === undefined ? undefined : { supportsTaskStop: stops, supportsStopAll: stops }
}

/** Probes the session's app-server off the frame path when a running command has a process a stop
 *  could name, until it answers; a yes restates the running commands as stoppable. */
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

/** Stops the backgrounded commands the named tasks run, while `session` is still the one the host
 *  asked about. Cancelled when at least one is gone. */
export async function stopCodexBackgroundCommands(
  sessions: Map<string, CodexSession>,
  input: { sessionId: string; fence: number; taskIds: readonly string[] },
  timeoutMs: number | undefined
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const session = requireLiveCodexSession(sessions, input.sessionId)
  const terminals = session.backgroundTasks.backgroundProcesses(input.taskIds)
  if (terminals.length === 0) {
    return { cancelled: false }
  }
  const { acquisitionGeneration } = session
  const { stopped, survived } = await terminateCodexBackgroundTerminals(
    session.connection,
    terminals,
    {
      timeoutMs,
      isCurrent: () =>
        sessions.get(input.sessionId) === session &&
        !session.ended &&
        session.fence === input.fence &&
        session.acquisitionGeneration === acquisitionGeneration
    }
  )
  return { cancelled: stopped > 0, ...(survived ? { stillRunning: true as const } : {}) }
}
