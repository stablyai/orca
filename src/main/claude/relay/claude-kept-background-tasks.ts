import type { ClaudeSession } from '../structured/claude-structured-session-state'

/**
 * A kept agent's background tasks started before this app did, so their starts aren't replayed:
 * each still-open one is restated as live (the journal already has its row, so none is written).
 */
export function restateKeptClaudeBackgroundTasks(
  session: Pick<ClaudeSession, 'childWork' | 'backgroundTasks'> &
    Partial<Pick<ClaudeSession, 'translator'>>,
  taskIds: readonly string[]
): void {
  for (const task_id of taskIds) {
    const frame = {
      type: 'system',
      subtype: 'task_started',
      task_id,
      // Foreground commands are open work too; only the journal knows which ran in the background.
      is_backgrounded: session.childWork.taskInvocations.savedAsBackground(task_id),
      status: 'running'
    }
    session.childWork.observe(frame, session.translator?.childToolOwner)
    session.backgroundTasks.observe(frame)
  }
}
