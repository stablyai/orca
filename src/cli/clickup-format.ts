import type { ClickUpConnectionStatus, ClickUpList, ClickUpTask } from '../shared/clickup-types'
function taskReference(task: ClickUpTask): string {
  return task.customId ?? task.id
}

export function formatClickUpTask(task: ClickUpTask | null): string {
  if (!task) {
    return 'ClickUp task not found.'
  }
  return [
    `${taskReference(task)} ${task.name}`,
    `Status: ${task.status.name}`,
    `Workspace: ${task.workspaceName ?? task.workspaceId}`,
    `List: ${task.list.name}`,
    task.priority ? `Priority: ${task.priority.name}` : null,
    task.dueDate ? `Due: ${task.dueDate.slice(0, 10)}` : null,
    `URL: ${task.url}`,
    task.description ? `\n${task.description}` : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function formatClickUpTasks(tasks: ClickUpTask[]): string {
  if (tasks.length === 0) {
    return 'No ClickUp tasks found.'
  }
  return tasks
    .map(
      (task) =>
        `${taskReference(task)}\t${task.status.name}\t${task.name}\t${task.workspaceName ?? task.workspaceId}`
    )
    .join('\n')
}

export function formatClickUpWorkspaces(status: ClickUpConnectionStatus): string {
  if (!status.connected) {
    return 'ClickUp is not connected.'
  }
  return (status.workspaces ?? [])
    .map((workspace) => `${workspace.id}\t${workspace.name}`)
    .join('\n')
}

export function formatClickUpLists(lists: ClickUpList[]): string {
  if (lists.length === 0) {
    return 'No ClickUp Lists found.'
  }
  return lists
    .map((list) =>
      [
        list.id,
        list.workspaceName ?? list.workspaceId,
        list.space?.name ?? '',
        list.folder?.name ?? '',
        list.name
      ].join('\t')
    )
    .join('\n')
}

export function formatClickUpMutation(result: { ok: boolean; error?: string }): string {
  return result.ok ? 'Updated ClickUp task.' : (result.error ?? 'ClickUp update failed.')
}

export function formatClickUpCreate(result: {
  ok: boolean
  task?: ClickUpTask
  error?: string
}): string {
  return result.ok && result.task
    ? formatClickUpTask(result.task)
    : (result.error ?? 'Create failed.')
}
