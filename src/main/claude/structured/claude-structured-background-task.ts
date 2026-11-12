import type { AgentSessionForegroundTask } from '../../../shared/agent-session/agent-session-foreground-task'
import type { ClaudeSession } from './claude-structured-session-state'

export function claudeForegroundTasks(
  session: ClaudeSession | undefined
): AgentSessionForegroundTask[] {
  const turnId = session?.translator?.currentTurnId
  if (!session || !turnId || !session.connection.backgroundTasks || session.connection.closed) {
    return []
  }
  return (session.translator?.foregroundToolIds?.() ?? [])
    .filter((toolUseId) => !session.prompts.awaitsTool(toolUseId))
    .flatMap((toolUseId) => {
      const task = session.childWork.taskForToolUse(toolUseId)
      return task?.backgrounded
        ? []
        : [
            {
              toolUseId,
              turnId,
              generation: session.acquisitionGeneration,
              ...(task ? { taskId: task.taskId } : {})
            }
          ]
    })
}

export async function backgroundClaudeTask(
  sessions: ReadonlyMap<string, ClaudeSession>,
  input: AgentSessionForegroundTask & { sessionId: string; fence: number },
  timeoutMs?: number
): Promise<boolean> {
  const session = sessions.get(input.sessionId)
  if (
    session?.fence !== input.fence ||
    !claudeForegroundTasks(session).some(
      (task) =>
        task.toolUseId === input.toolUseId &&
        task.turnId === input.turnId &&
        task.generation === input.generation
    )
  ) {
    return false
  }
  return session.connection.backgroundTasks?.(input.toolUseId, { timeoutMs }) ?? false
}
