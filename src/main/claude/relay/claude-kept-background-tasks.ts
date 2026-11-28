import type { ClaudeSession } from '../structured/claude-structured-session-state'

/**
 * A kept agent's background tasks started before this app did, so their starts aren't replayed:
 * each still-open one is restated as live (the journal already has its row, so none is written).
 */
const withLaunch = (toolUseId: string | undefined) => (toolUseId ? { tool_use_id: toolUseId } : {})

export function restateKeptClaudeBackgroundTasks(
  session: Pick<ClaudeSession, 'childWork' | 'backgroundTasks'> &
    Partial<Pick<ClaudeSession, 'translator'>>,
  taskIds: readonly string[],
  /** The last app left a turn running; with none, every open task is background work. */
  turnRunning: boolean,
  /** Saved subagents' launching calls, by task id. */
  launches: ReadonlyMap<string, string> = new Map()
): void {
  const invocations = session.childWork.taskInvocations
  const starts = taskIds.map((task_id) => ({
    type: 'system',
    subtype: 'task_started',
    task_id,
    // A subagent's kind and launching call are only in its unreplayed start; without them the task
    // reads as unknown work and a follow-up can't send it to the background.
    ...(invocations.savedAsSubagent(task_id) ? { task_type: 'local_agent' } : {}),
    ...withLaunch(launches.get(task_id) ?? invocations.savedLaunch(task_id)),
    // Foreground work ends with its turn; mid-turn, only the journal knows which ran in the background.
    is_backgrounded: !turnRunning || invocations.savedAsBackground(task_id),
    status: 'running'
  }))
  for (const start of starts) {
    session.childWork.observe(start, session.translator?.childToolOwner)
  }
  // One roster rebuild for all of them, not one per task.
  session.backgroundTasks.restate(starts)
}
