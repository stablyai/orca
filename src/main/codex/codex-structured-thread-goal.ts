import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../shared/agent-session-goal-control-copy'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolvedCodexGoalSettings } from './codex-structured-message-options'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-thread-goal-wire'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type { CodexSession } from './codex-structured-session-state'

type CodexThreadGoalRequest = {
  method: 'thread/goal/set' | 'thread/goal/clear'
  params: Record<string, unknown>
}

export function codexThreadGoalRequests(
  threadId: string,
  change: AgentSessionThreadGoalChange,
  replacesGoal: boolean
): CodexThreadGoalRequest[] {
  const clear: CodexThreadGoalRequest = {
    method: 'thread/goal/clear',
    params: { threadId, origin: 'user' }
  }
  if (change.kind === 'clear') {
    return [clear]
  }
  if (change.kind === 'status') {
    return [
      { method: 'thread/goal/set', params: { threadId, origin: 'user', status: change.status } }
    ]
  }
  // Clear replacements to reset identity/usage; activating a goal starts work without a turn.
  return [
    ...(replacesGoal ? [clear] : []),
    {
      method: 'thread/goal/set',
      params: { threadId, origin: 'user', objective: change.objective, status: 'active' }
    }
  ]
}

export async function changeCodexThreadGoal(
  session: Pick<CodexSession, 'connection' | 'threadId'>,
  change: AgentSessionThreadGoalChange,
  replacesGoal: boolean,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; rejected: string }> {
  let cleared = false
  try {
    for (const request of codexThreadGoalRequests(session.threadId, change, replacesGoal)) {
      throwIfSignalAborted(signal)
      await session.connection.request(request.method, request.params, { timeoutMs })
      cleared ||= request.method === 'thread/goal/clear'
    }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      return {
        ok: false,
        rejected: cleared
          ? 'Codex cleared the previous goal but could not set the new goal. Set the goal again to continue.'
          : error.message
      }
    }
    throw error
  }
  return { ok: true }
}

export async function changeCodexThreadGoalWithSettings(
  session: CodexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>[0],
  timeoutMs: number | undefined,
  current: () => boolean
): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const generation = session.acquisitionGeneration
  const startsWork =
    input.change.kind === 'set' ||
    (input.change.kind === 'status' && input.change.status === 'active')
  try {
    if (startsWork) {
      const requested = resolvedCodexGoalSettings(session, input.executionOptions)
      const previousApplied = session.appliedTurnOptions
      const installed = await session.appliedSettings?.install(
        session.connection,
        session.threadId,
        requested,
        timeoutMs,
        input.signal,
        () => {
          session.appliedTurnOptions = { ...session.appliedTurnOptions, ...requested }
        },
        () => {
          session.appliedTurnOptions = previousApplied
        },
        () => {
          const known = { ...previousApplied }
          for (const key of ['model', 'effort'] as const) {
            if (requested[key] !== undefined && requested[key] !== known[key]) {
              delete known[key]
            }
          }
          session.appliedTurnOptions = known
        }
      )
      if (installed && !installed.ok) {
        return installed
      }
    }
    throwIfSignalAborted(input.signal)
    if (
      !current() ||
      session.ended ||
      session.fence !== input.fence ||
      session.acquisitionGeneration !== generation
    ) {
      throw new Error('codex goal acquisition ended')
    }
  } catch (error) {
    if (!startsWork) {
      throw error
    }
    // No goal write has been issued, even if the preceding settings write is uncertain.
    return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.settingsUnconfirmed }
  }
  return changeCodexThreadGoal(session, input.change, input.replacesGoal, timeoutMs, input.signal)
}
