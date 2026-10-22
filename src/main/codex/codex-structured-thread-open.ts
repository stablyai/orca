// Starting or resuming the single Codex thread a structured session owns.
//
// The reply is verified before the caller registers the session, because a
// resume that lands on a different thread is a fork wearing a resume's name —
// recording it would make the durable handle chain lie about what this session
// actually proved.

import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import type { CodexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import { readCodexThreadId } from './codex-structured-thread-facts'

export type CodexOpenedThread = {
  threadId: string
  /** The unsaved thread this new one was started in place of. */
  supersededThreadId?: string
  thread?: Record<string, unknown>
  historyMode?: 'legacy' | 'paginated'
  model?: string
  effort?: string
  /** Present, including null, only when this app-server reports the effective tier. */
  serviceTier?: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Codex's own answer that it holds no rollout for this exact thread: the thread was started but
 * never given input, so there is no conversation to lose. Codex matches the same exact text
 * internally; any other resume failure, including a broader "not found", is not this proof.
 * Orca's own wrapper prefix is deliberately not part of the match.
 * Codex also uses this text for an archived thread read active-only; resume reads archived threads
 * and answers "is archived" instead, so here the text means no rollout exists at all.
 */
function isCodexNoRolloutError(error: unknown, threadId: string): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.method === 'thread/resume' &&
    error.code === -32600 &&
    error.message.endsWith(`no rollout found for thread id ${threadId}`)
  )
}

/**
 * Codex rebuilds each command's env from `shell_environment_policy`, so `inherit = "core"` drops
 * every Orca key the app-server holds. Codex adds `set` keys after that filter and merges these
 * per key, so the user's own policy stays as written.
 */
function shellEnvironmentSetConfig(
  env: Record<string, string> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [`shell_environment_policy.set.${key}`, value])
  )
}

export async function openCodexThread(
  connection: Pick<CodexAppServerConnection, 'request'>,
  launch: {
    cwd: string
    resumeThreadId: string | null
    supersedeIfUnsaved?: boolean
    permissionPolicy?: CodexStructuredPermissionPolicy
    /** Why: Codex renders a thread's base instructions for its opening model; a first turn on
     *  another model reads as a mid-conversation switch and injects a second full prompt. */
    model?: string
    /** Config overrides for this thread, on start and resume alike. */
    threadConfig?: Record<string, unknown>
    /** Env every command the agent runs must see, whatever the user's shell environment policy. */
    commandEnv?: Record<string, string>
  },
  /** null: no deadline; the start that opens the thread bounds it (`signal`). */
  timeoutMs: number | null | undefined,
  signal?: AbortSignal
): Promise<CodexOpenedThread> {
  const resumeThreadId = launch.resumeThreadId
  const config = { ...launch.threadConfig, ...shellEnvironmentSetConfig(launch.commandEnv) }
  const threadSettings = {
    cwd: launch.cwd,
    ...launch.permissionPolicy,
    ...(Object.keys(config).length > 0 ? { config } : {})
  }
  const startThread = (): Promise<unknown> => {
    throwIfSignalAborted(signal)
    return connection.request(
      'thread/start',
      { ...threadSettings, ...(launch.model ? { model: launch.model } : {}) },
      { timeoutMs }
    )
  }
  let supersededThreadId: string | undefined
  let opened: unknown
  if (!resumeThreadId) {
    opened = await startThread()
  } else {
    // No model: naming one makes Codex skip the thread's saved model, provider and effort.
    const resumeParams = {
      threadId: resumeThreadId,
      ...threadSettings
    }
    try {
      throwIfSignalAborted(signal)
      opened = await connection.request(
        'thread/resume',
        { ...resumeParams, excludeTurns: true },
        { timeoutMs }
      )
    } catch (error) {
      throwIfSignalAborted(signal)
      if (!launch.supersedeIfUnsaved || !isCodexNoRolloutError(error, resumeThreadId)) {
        throw error
      }
      supersededThreadId = resumeThreadId
      opened = await startThread()
    }
  }
  const threadId = readCodexThreadId(opened)
  if (!threadId) {
    throw new Error('codex app-server did not name the thread it opened')
  }
  if (supersededThreadId === undefined && resumeThreadId && threadId !== resumeThreadId) {
    throw new Error(`codex app-server resumed ${threadId} instead of ${resumeThreadId}`)
  }
  const result = opened as Record<string, unknown>
  const thread =
    typeof result.thread === 'object' && result.thread !== null
      ? (result.thread as Record<string, unknown>)
      : {}
  const model = nonEmptyString(result.model)
  const effort = nonEmptyString(result.reasoningEffort)
  const serviceTierKnown = Object.hasOwn(result, 'serviceTier')
  const serviceTier = nonEmptyString(result.serviceTier)
  return {
    threadId,
    ...(supersededThreadId === undefined ? {} : { supersededThreadId }),
    thread,
    ...(thread.historyMode === 'legacy' || thread.historyMode === 'paginated'
      ? { historyMode: thread.historyMode }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTierKnown ? { serviceTier } : {})
  }
}
