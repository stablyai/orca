import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
// Starting or resuming the single Codex thread a structured session owns.
//
// The reply is verified before the caller registers the session, because a
// resume that lands on a different thread is a fork wearing a resume's name —
// recording it would make the durable handle chain lie about what this session
// actually proved.

import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { readCodexThreadId, readCodexThreadPath } from './codex-structured-thread-facts'

export type CodexOpenedThread = {
  threadId: string
  thread?: Record<string, unknown>
  /** Rollout file Codex named, when it named one. */
  historyPath: string | null
  historyMode?: 'legacy' | 'paginated'
  model?: string
  effort?: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

// Scoped to the connection that executes it — one app-server per host — and to the method, because
// a server may implement `excludeTurns` on one of these and not the other.
const excludeTurnsUnsupported = new WeakMap<object, Set<string>>()

function isExcludeTurnsUnsupported(error: unknown): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.code === -32602 &&
    /(?:unknown|unexpected|unsupported|unrecognized).{0,80}excludeTurns|excludeTurns.{0,80}(?:unknown|unexpected|unsupported|unrecognized)/i.test(
      error.message
    )
  )
}

/** `excludeTurns` only trims the reply; every caller re-reads history, so dropping it costs nothing
 *  but payload size. Treat it as an optional server capability rather than a hard requirement. */
async function openThreadExcludingTurns(
  connection: Pick<CodexAppServerConnection, 'request'>,
  method: 'thread/resume' | 'thread/fork',
  params: Record<string, unknown>,
  timeoutMs: number | undefined
): Promise<unknown> {
  if (excludeTurnsUnsupported.get(connection)?.has(method)) {
    return connection.request(method, params, { timeoutMs })
  }
  try {
    return await connection.request(method, { ...params, excludeTurns: true }, { timeoutMs })
  } catch (error) {
    if (!isExcludeTurnsUnsupported(error)) {
      throw error
    }
    const refused = excludeTurnsUnsupported.get(connection) ?? new Set<string>()
    refused.add(method)
    excludeTurnsUnsupported.set(connection, refused)
    return connection.request(method, params, { timeoutMs })
  }
}

export async function openCodexThread(
  connection: Pick<CodexAppServerConnection, 'request'>,
  launch: { cwd: string; resumeThreadId: string | null; resumePath?: string | null },
  timeoutMs: number | undefined,
  fork?: AgentSessionForkTarget
): Promise<CodexOpenedThread> {
  const resumeParams = launch.resumeThreadId
    ? {
        threadId: launch.resumeThreadId,
        cwd: launch.cwd,
        ...(launch.resumePath ? { path: launch.resumePath } : {})
      }
    : null
  if (
    fork &&
    (fork.source.provider !== 'codex' || fork.source.threadId !== launch.resumeThreadId)
  ) {
    throw new Error('agent_session_identity_required')
  }
  const opened =
    fork && fork.source.provider === 'codex'
      ? await openThreadExcludingTurns(
          connection,
          'thread/fork',
          {
            threadId: fork.source.threadId,
            lastTurnId: fork.throughId,
            cwd: launch.cwd
          },
          timeoutMs
        )
      : resumeParams
        ? await openThreadExcludingTurns(connection, 'thread/resume', resumeParams, timeoutMs)
        : await connection.request('thread/start', { cwd: launch.cwd }, { timeoutMs })
  const threadId = readCodexThreadId(opened)
  if (!threadId) {
    throw new Error('codex app-server did not name the thread it opened')
  }
  if (!fork && launch.resumeThreadId && threadId !== launch.resumeThreadId) {
    throw new Error(`codex app-server resumed ${threadId} instead of ${launch.resumeThreadId}`)
  }
  const result = opened as Record<string, unknown>
  const thread =
    typeof result.thread === 'object' && result.thread !== null
      ? (result.thread as Record<string, unknown>)
      : {}
  if (
    fork &&
    fork.source.provider === 'codex' &&
    (threadId === fork.source.threadId || thread.forkedFromId !== fork.source.threadId)
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const model = nonEmptyString(result.model)
  const effort = nonEmptyString(result.reasoningEffort)
  return {
    threadId,
    thread,
    historyPath: readCodexThreadPath(opened),
    ...(thread.historyMode === 'legacy' || thread.historyMode === 'paginated'
      ? { historyMode: thread.historyMode }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}
