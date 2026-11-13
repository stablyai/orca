import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../../../shared/agent-session/view/agent-session-goal-control-copy'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { resolvedCodexGoalSettings } from '../turns/codex-structured-message-options'
import { throwIfSignalAborted } from '../../../../shared/abort-signal-reason'
import type { AgentSessionThreadGoalChange } from '../../../../shared/agent-session/agent-session-thread-goal-wire'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'

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

/** After Codex refuses a status change, whether it had no goal to change; unknown counts as a goal. */
async function codexThreadGoalMissing(
  session: Pick<CodexSession, 'connection' | 'threadId'>,
  timeoutMs: number | undefined
): Promise<boolean> {
  try {
    const read = await session.connection.request(
      'thread/goal/get',
      { threadId: session.threadId },
      { timeoutMs }
    )
    return typeof read === 'object' && read !== null && 'goal' in read && read.goal === null
  } catch {
    return false
  }
}

function readCodexClearedFlag(response: unknown): boolean | undefined {
  return typeof response === 'object' &&
    response !== null &&
    'cleared' in response &&
    typeof response.cleared === 'boolean'
    ? response.cleared
    : undefined
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
      const response = await session.connection.request(request.method, request.params, {
        timeoutMs
      })
      // A clear on its own reports whether a goal existed; Codex says nothing else when none did.
      if (change.kind === 'clear' && readCodexClearedFlag(response) === false) {
        return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.noGoal }
      }
      cleared ||= request.method === 'thread/goal/clear'
    }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      // Codex words a missing goal with internal ids; say it in the user's terms instead.
      if (change.kind === 'status') {
        throwIfSignalAborted(signal)
        const missing = await codexThreadGoalMissing(session, timeoutMs)
        throwIfSignalAborted(signal)
        if (missing) {
          return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.noGoal }
        }
      }
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
      let previousApplied = session.appliedTurnOptions
      let previousInput = session.appliedTurnInputOptions
      let invalidatedApplied: CodexSession['appliedTurnOptions']
      let invalidatedInput: CodexSession['appliedTurnInputOptions']
      const ownsAcquisition = () =>
        current() &&
        !session.ended &&
        !session.connection.closed &&
        session.fence === input.fence &&
        session.acquisitionGeneration === generation
      const installed = await session.appliedSettings?.install(
        session.connection,
        session.threadId,
        requested,
        timeoutMs,
        input.signal,
        () => {
          if (!ownsAcquisition()) {
            return
          }
          if (session.appliedTurnOptions === invalidatedApplied) {
            session.appliedTurnOptions = { ...invalidatedApplied, ...requested }
          }
          if (session.appliedTurnInputOptions === invalidatedInput) {
            session.appliedTurnInputOptions = { ...invalidatedInput, ...requested }
          }
        },
        () => {
          if (!ownsAcquisition()) {
            return
          }
          if (session.appliedTurnOptions === invalidatedApplied) {
            session.appliedTurnOptions = previousApplied
          }
          if (session.appliedTurnInputOptions === invalidatedInput) {
            session.appliedTurnInputOptions = previousInput
          }
        },
        () => {
          previousApplied = session.appliedTurnOptions
          previousInput = session.appliedTurnInputOptions
          const known = { ...previousApplied }
          const knownInput = { ...previousInput }
          for (const key of ['model', 'effort'] as const) {
            if (requested[key] !== undefined && requested[key] !== known[key]) {
              delete known[key]
            }
            if (requested[key] !== undefined && requested[key] !== knownInput[key]) {
              delete knownInput[key]
            }
          }
          invalidatedApplied = known
          invalidatedInput = knownInput
          session.appliedTurnOptions = invalidatedApplied
          session.appliedTurnInputOptions = invalidatedInput
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
