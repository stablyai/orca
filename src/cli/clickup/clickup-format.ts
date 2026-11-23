import type {
  ClickUpComment,
  ClickUpConnectionStatus,
  ClickUpTask,
  ClickUpTaskPage,
  ClickUpUser
} from '../../shared/clickup/clickup-types'

export const CLICKUP_RECENT_COMMENT_LIMIT = 10

export type ClickUpTaskContext = { task: ClickUpTask; comments: ClickUpComment[] }

function taskReference(task: ClickUpTask): string {
  return task.customId ?? task.id
}

function userName(user: ClickUpUser | null): string {
  return user?.username ?? 'unknown'
}

export function formatClickUpStatus(status: ClickUpConnectionStatus): string {
  if (status.credentialError) {
    return status.credentialError
  }
  if (!status.connected) {
    return 'Not connected. Add a ClickUp personal API token in Orca Settings.'
  }
  return [
    `Connected as ${status.viewer?.username ?? 'unknown'}${status.viewer?.email ? ` <${status.viewer.email}>` : ''}`,
    ...status.workspaces.map(
      (workspace) =>
        `${workspace.id}\t${workspace.name}${status.selectedWorkspaceId === workspace.id ? '\t(selected)' : ''}`
    )
  ].join('\n')
}

export function formatClickUpTaskContext({ task, comments }: ClickUpTaskContext): string {
  const lines = [
    `${taskReference(task)} ${task.name}`,
    `URL: ${task.url}`,
    `ID: ${task.id}`,
    `Status: ${task.status.name} (${task.status.type})`,
    `Priority: ${task.priority?.label ?? 'none'}`,
    `Assignees: ${task.assignees.map((user) => user.username).join(', ') || 'unassigned'}`,
    `Creator: ${userName(task.creator)}`,
    `List: ${task.folder ? `${task.folder.name} / ` : ''}${task.list.name} (${task.list.id})`
  ]
  if (task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }
  if (task.parentId) {
    lines.push(`Parent: ${task.parentId}`)
  }
  if (task.dueAt) {
    lines.push(`Due: ${task.dueAt}`)
  }
  lines.push(`Updated: ${task.updatedAt}`)
  if (task.descriptionMarkdown) {
    lines.push('', task.descriptionMarkdown)
  }
  if (comments.length > 0) {
    const recent = comments.slice(-CLICKUP_RECENT_COMMENT_LIMIT)
    lines.push('', `Recent comments (${recent.length} of ${comments.length}):`)
    for (const comment of recent) {
      lines.push('', `${userName(comment.author)} — ${comment.createdAt}`, comment.body)
    }
  }
  return lines.join('\n')
}

export function formatClickUpTaskList(tasks: ClickUpTask[]): string {
  if (tasks.length === 0) {
    return 'No tasks.'
  }
  return tasks
    .map(
      (task) =>
        `${taskReference(task)}\t${task.status.name}\t${task.assignees.map((user) => user.username).join(', ') || 'unassigned'}\t${task.name}`
    )
    .join('\n')
}

export function formatClickUpTaskPage(page: ClickUpTaskPage): string {
  const list = formatClickUpTaskList(page.tasks)
  return page.nextPage === null ? list : `${list}\n\nMore tasks: --page ${page.nextPage}`
}
