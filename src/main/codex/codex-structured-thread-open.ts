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
  /** This app-server reports who reviews approvals, so it can route them to auto-review. */
  approvalsReviewerSupported?: boolean
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

const resumeMetadataUnsupported = new WeakSet<object>()
const approvalsReviewerUnsupported = new WeakSet<object>()

/** An app-server that predates approval reviewers refuses the field; the open retries without
 *  it, which is the reviewer that app-server always had: a person. */
function isApprovalsReviewerUnsupported(error: unknown): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.code === -32602 &&
    /(?:unknown|unexpected|unsupported|unrecognized).{0,80}approvalsReviewer|approvalsReviewer.{0,80}(?:unknown|unexpected|unsupported|unrecognized)/i.test(
      error.message
    )
  )
}

async function withoutUnsupportedReviewer(
  connection: Pick<CodexAppServerConnection, 'request'>,
  params: Record<string, unknown>,
  open: (params: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  try {
    if (approvalsReviewerUnsupported.has(connection)) {
      const { approvalsReviewer: _unsupported, ...rest } = params
      return await open(rest)
    }
    return await open(params)
  } catch (error) {
    if (!('approvalsReviewer' in params) || !isApprovalsReviewerUnsupported(error)) {
      throw error
    }
    const { approvalsReviewer: _unsupported, ...rest } = params
    approvalsReviewerUnsupported.add(connection)
    return open(rest)
  }
}

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

export async function openCodexThread(
  connection: Pick<CodexAppServerConnection, 'request'>,
  launch: {
    cwd: string
    resumeThreadId: string | null
    resumePath?: string | null
    supersedeIfUnsaved?: boolean
    permissionPolicy?: CodexStructuredPermissionPolicy
    /** Why: Codex renders a thread's base instructions for its opening model; a first turn on
     *  another model reads as a mid-conversation switch and injects a second full prompt. */
    model?: string
    /** Config overrides for this thread, on start and resume alike. */
    threadConfig?: Record<string, unknown>
  },
  timeoutMs: number | undefined
): Promise<CodexOpenedThread> {
  const resumeThreadId = launch.resumeThreadId
  const threadSettings = {
    cwd: launch.cwd,
    ...launch.permissionPolicy,
    ...(launch.threadConfig ? { config: launch.threadConfig } : {})
  }
  const startThread = (): Promise<unknown> =>
    withoutUnsupportedReviewer(
      connection,
      { ...threadSettings, ...(launch.model ? { model: launch.model } : {}) },
      (params) => connection.request('thread/start', params, { timeoutMs })
    )
  let supersededThreadId: string | undefined
  let opened: unknown
  if (!resumeThreadId) {
    opened = await startThread()
  } else {
    // No model: naming one makes Codex skip the thread's saved model, provider and effort.
    const resumeParams = {
      threadId: resumeThreadId,
      ...threadSettings,
      ...(launch.resumePath ? { path: launch.resumePath } : {})
    }
    try {
      opened = await withoutUnsupportedReviewer(connection, resumeParams, (params) =>
        resumeCodexThread(connection, params, timeoutMs)
      )
    } catch (error) {
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
  if (typeof opened !== 'object' || opened === null) {
    throw new Error('codex app-server did not return thread details')
  }
  const result = opened
  const thread =
    'thread' in result && typeof result.thread === 'object' && result.thread !== null
      ? result.thread
      : {}
  const model = nonEmptyString('model' in result ? result.model : undefined)
  const effort = nonEmptyString('reasoningEffort' in result ? result.reasoningEffort : undefined)
  const serviceTierKnown = Object.hasOwn(result, 'serviceTier')
  const serviceTier = nonEmptyString('serviceTier' in result ? result.serviceTier : undefined)
  return {
    threadId,
    ...(supersededThreadId === undefined ? {} : { supersededThreadId }),
    thread: { ...thread },
    ...('historyMode' in thread &&
    (thread.historyMode === 'legacy' || thread.historyMode === 'paginated')
      ? { historyMode: thread.historyMode }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTierKnown ? { serviceTier } : {}),
    approvalsReviewerSupported:
      !approvalsReviewerUnsupported.has(connection) && Object.hasOwn(result, 'approvalsReviewer')
  }
}
