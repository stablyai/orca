import {
  todoistTaskUrl,
  type TodoistComment,
  type TodoistTask,
  type TodoistViewer
} from '../../shared/todoist-types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asPriority(value: unknown): TodoistTask['priority'] {
  return value === 2 || value === 3 || value === 4 ? value : 1
}

export function mapTodoistViewer(value: unknown): TodoistViewer | null {
  const raw = asRecord(value)
  const id = raw?.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    return null
  }
  return {
    id: String(id),
    fullName: asString(raw?.full_name) ?? '',
    email: asString(raw?.email) ?? ''
  }
}

export function mapTodoistTask(
  value: unknown,
  projectNames: Map<string, string>
): TodoistTask | null {
  const raw = asRecord(value)
  const id = asString(raw?.id)
  const content = asString(raw?.content)
  // Why: Todoist keeps serving deleted tasks by id, flagged is_deleted.
  if (!raw || !id || content === null || raw.is_deleted === true) {
    return null
  }
  const projectId = asString(raw.project_id) ?? ''
  const due = asRecord(raw.due)
  const dueDate = asString(due?.datetime) ?? asString(due?.date)
  return {
    id,
    content,
    description: asString(raw.description) ?? '',
    projectId,
    projectName: projectNames.get(projectId) ?? null,
    priority: asPriority(raw.priority),
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((l): l is string => typeof l === 'string')
      : [],
    due: dueDate
      ? { date: dueDate, string: asString(due?.string), isRecurring: due?.is_recurring === true }
      : null,
    url: todoistTaskUrl(id),
    addedAt: asString(raw.added_at),
    completed: raw.checked === true
  }
}

export function mapTodoistComment(value: unknown): TodoistComment | null {
  const raw = asRecord(value)
  const id = asString(raw?.id)
  if (!raw || !id || raw.is_deleted === true) {
    return null
  }
  return { id, content: asString(raw.content) ?? '', postedAt: asString(raw.posted_at) }
}
