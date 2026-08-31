// Starting or resuming the single Codex thread a structured session owns.
//
// The reply is verified before the caller registers the session, because a
// resume that lands on a different thread is a fork wearing a resume's name —
// recording it would make the durable handle chain lie about what this session
// actually proved.

import type { CodexAppServerConnection } from './codex-app-server-connection'
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

export async function openCodexThread(
  connection: CodexAppServerConnection,
  launch: { cwd: string; resumeThreadId: string | null; resumePath?: string | null },
  timeoutMs: number | undefined
): Promise<CodexOpenedThread> {
  const opened = await connection.request(
    launch.resumeThreadId ? 'thread/resume' : 'thread/start',
    launch.resumeThreadId
      ? {
          threadId: launch.resumeThreadId,
          cwd: launch.cwd,
          ...(launch.resumePath ? { path: launch.resumePath } : {})
        }
      : { cwd: launch.cwd },
    { timeoutMs }
  )
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
