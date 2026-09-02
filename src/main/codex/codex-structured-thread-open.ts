// Starting or resuming the single Codex thread a structured session owns.
//
// The reply is verified before the caller registers the session, because a
// resume that lands on a different thread is a fork wearing a resume's name —
// recording it would make the durable handle chain lie about what this session
// actually proved.

import {
  CODEX_APP_SERVER_MAX_RECORD_BYTES,
  CodexAppServerFrameSizeError,
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { readCodexThreadId, readCodexThreadPath } from './codex-structured-thread-facts'

export type CodexOpenedThread = {
  threadId: string
  thread?: Record<string, unknown>
  /** Rollout file Codex named, when it named one. */
  historyPath: string | null
  model?: string
  effort?: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

const resumeMetadataUnsupported = new WeakSet<object>()

function isExcludeTurnsUnsupported(error: unknown): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.code === -32602 &&
    /(?:unknown|unexpected|unsupported|unrecognized).{0,80}excludeTurns|excludeTurns.{0,80}(?:unknown|unexpected|unsupported|unrecognized)/i.test(
      error.message
    )
  )
}

async function resumeCodexThread(
  connection: Pick<CodexAppServerConnection, 'request'>,
  params: Record<string, unknown>,
  timeoutMs: number | undefined
): Promise<unknown> {
  if (resumeMetadataUnsupported.has(connection)) {
    return connection.request('thread/resume', params, { timeoutMs })
  }
  try {
    return await connection.request(
      'thread/resume',
      { ...params, excludeTurns: true },
      { timeoutMs }
    )
  } catch (error) {
    if (!isExcludeTurnsUnsupported(error)) {
      throw error
    }
    resumeMetadataUnsupported.add(connection)
    return connection.request('thread/resume', params, { timeoutMs })
  }
}

function assertBoundedAcquisitionResult(method: string, opened: unknown): void {
  const encoded = JSON.stringify(opened)
  if (encoded === undefined) {
    return
  }
  const encodedBytes = Buffer.byteLength(encoded, 'utf8')
  if (encodedBytes > CODEX_APP_SERVER_MAX_RECORD_BYTES) {
    throw new CodexAppServerFrameSizeError(method, encodedBytes, CODEX_APP_SERVER_MAX_RECORD_BYTES)
  }
}

export async function openCodexThread(
  connection: Pick<CodexAppServerConnection, 'request'>,
  launch: { cwd: string; resumeThreadId: string | null; resumePath?: string | null },
  timeoutMs: number | undefined
): Promise<CodexOpenedThread> {
  const resumeParams = launch.resumeThreadId
    ? {
        threadId: launch.resumeThreadId,
        cwd: launch.cwd,
        ...(launch.resumePath ? { path: launch.resumePath } : {})
      }
    : null
  const opened = resumeParams
    ? await resumeCodexThread(connection, resumeParams, timeoutMs)
    : await connection.request('thread/start', { cwd: launch.cwd }, { timeoutMs })
  assertBoundedAcquisitionResult(resumeParams ? 'thread/resume' : 'thread/start', opened)
  const threadId = readCodexThreadId(opened)
  if (!threadId) {
    throw new Error('codex app-server did not name the thread it opened')
  }
  if (launch.resumeThreadId && threadId !== launch.resumeThreadId) {
    throw new Error(`codex app-server resumed ${threadId} instead of ${launch.resumeThreadId}`)
  }
  const result = opened as Record<string, unknown>
  const thread =
    typeof result.thread === 'object' && result.thread !== null
      ? (result.thread as Record<string, unknown>)
      : {}
  const model = nonEmptyString(result.model)
  const effort = nonEmptyString(result.reasoningEffort)
  return {
    threadId,
    thread,
    historyPath: readCodexThreadPath(opened),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}
