import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-thread-goal-wire'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
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
  const clear: CodexThreadGoalRequest = { method: 'thread/goal/clear', params: { threadId } }
  if (change.kind === 'clear') {
    return [clear]
  }
  if (change.kind === 'status') {
    return [{ method: 'thread/goal/set', params: { threadId, status: change.status } }]
  }
  // Clear replacements to reset identity/usage; activating a goal starts work without a turn.
  return [
    ...(replacesGoal ? [clear] : []),
    {
      method: 'thread/goal/set',
      params: { threadId, objective: change.objective, status: 'active' }
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
  try {
    for (const request of codexThreadGoalRequests(session.threadId, change, replacesGoal)) {
      throwIfSignalAborted(signal)
      await session.connection.request(request.method, request.params, { timeoutMs })
    }
    return { ok: true }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      return { ok: false, rejected: error.message }
    }
    throw error
  }
}
