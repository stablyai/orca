import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-wire'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'

type CodexThreadGoalRequest = {
  method: 'thread/goal/set' | 'thread/goal/clear'
  params: Record<string, unknown>
}

/** The app-server requests that make one goal change on a thread, in order. */
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
  // `set` on an existing goal rewrites its objective and keeps its id and usage
  // counters, so a replacement clears first. An active goal on an idle thread
  // starts work by itself, so a set needs no turn.
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
  timeoutMs: number | undefined
): Promise<{ ok: true } | { ok: false; rejected: string }> {
  try {
    for (const request of codexThreadGoalRequests(session.threadId, change, replacesGoal)) {
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
