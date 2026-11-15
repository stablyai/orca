import type { OrchestrationDb } from '../orchestration-db'
import type { MessageRow } from '../orchestration-records'
import type { WorkspaceCheck } from '../../../../../shared/orchestration/workspace-pr-check'

export function withoutCallerWorkspaceCheck(payload: string | undefined): string | undefined {
  if (!payload) {
    return payload
  }
  try {
    const data = JSON.parse(payload)
    delete data.workspaceCheck
    return JSON.stringify(data)
  } catch {
    return payload
  }
}

export function recordWorkspacePrCheck(
  db: OrchestrationDb,
  message: MessageRow,
  taskId: string,
  check: WorkspaceCheck
): void {
  const payload = { ...JSON.parse(message.payload ?? '{}'), workspaceCheck: check }
  message.payload = JSON.stringify(payload)
  db.db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(message.payload, message.id)
  const task = db.getTask(taskId)
  const result = { ...JSON.parse(task?.result ?? '{}'), workspaceCheck: check }
  db.db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(JSON.stringify(result), taskId)
}
