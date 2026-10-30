import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { CodexStructuredPermissionPolicy } from '../../shared/codex-permission-policy'
import { readCodexThreadId } from './codex-structured-thread-facts'
import { readCodexSandboxPolicy, type CodexSandboxPolicy } from './codex-structured-sandbox-policy'

export type CodexOpenedThread = {
  threadId: string
  reportedPermissionMode?: string | null
  supersededThreadId?: string
  thread?: Record<string, unknown>
  historyMode?: 'legacy' | 'paginated'
  model?: string
  effort?: string | null
  /** Present, including null, only when this app-server reports the effective tier. */
  serviceTier?: string | null
  sandbox?: CodexSandboxPolicy
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Only this thread-specific resume error proves no rollout; archived resumes report "is archived". */
function isCodexNoRolloutError(error: unknown, threadId: string): boolean {
  return (
    isCodexAppServerRequestError(error) &&
    error.method === 'thread/resume' &&
    error.code === -32600 &&
    error.message.endsWith(`no rollout found for thread id ${threadId}`)
  )
}

/** Set keys merge after Codex's inheritance filter, preserving Orca identity under inherit = core. */
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
    /** Avoid a duplicate base prompt caused by switching models on the first turn. */
    model?: string
    threadConfig?: Record<string, unknown>
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
    // Omitting model preserves the resumed thread's model, provider and effort.
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
      if (
        isCodexAppServerRequestError(error) &&
        error.method === 'thread/resume' &&
        error.code === -32600 &&
        /\bthread\s+(\S+)\s+already has an active writer\b/i.exec(error.message)?.[1] ===
          resumeThreadId
      ) {
        throw withProviderDiagnostic(
          Object.assign(
            new AgentSessionAcquisitionRefusal(error.message, 'conversationOpenElsewhere'),
            { cause: error }
          ),
          providerDiagnostic(error.providerDiagnostic?.text ?? error.message, 'log')
        )
      }
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
  const sandbox = readCodexSandboxPolicy(result.sandbox)
  return {
    threadId,
    reportedPermissionMode: reportedCodexPermissionMode(result),
    ...(supersededThreadId === undefined ? {} : { supersededThreadId }),
    thread,
    ...(thread.historyMode === 'legacy' || thread.historyMode === 'paginated'
      ? { historyMode: thread.historyMode }
      : {}),
    ...(model ? { model } : {}),
    ...(effort || result.reasoningEffort === null ? { effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(serviceTierKnown ? { serviceTier } : {})
  }
}

/** Unrecognized policies remain the agent's settings rather than a guessed Orca mode. */
export function reportedCodexPermissionMode(reply: Record<string, unknown>): string | null {
  const approval = reply.approvalPolicy ?? reply.approval_policy
  const reviewer = reply.approvalsReviewer ?? reply.approvals_reviewer
  const sandbox = reply.sandbox
  const sandboxType =
    typeof sandbox === 'object' && sandbox !== null && 'type' in sandbox ? sandbox.type : sandbox
  const readOnly = sandboxType === 'readOnly' || sandboxType === 'read-only'
  const workspace = sandboxType === 'workspaceWrite' || sandboxType === 'workspace-write'
  const full = sandboxType === 'dangerFullAccess' || sandboxType === 'danger-full-access'
  if (approval === 'on-request' && reviewer === 'user' && readOnly) {
    return 'ask'
  }
  if (approval === 'on-request' && reviewer === 'auto_review' && workspace) {
    return 'auto'
  }
  if (approval === 'never' && reviewer === 'user' && full) {
    return 'full-access'
  }
  if (sandboxType === 'readOnly' || sandboxType === 'read-only') {
    return 'read-only'
  }
  if (
    (sandboxType === 'dangerFullAccess' || sandboxType === 'danger-full-access') &&
    approval === 'never'
  ) {
    return 'full-access'
  }
  if (
    (sandboxType === 'workspaceWrite' || sandboxType === 'workspace-write') &&
    approval === 'on-request'
  ) {
    return reviewer === 'auto_review' ? 'auto' : reviewer === 'user' ? 'ask' : null
  }
  return null
}
