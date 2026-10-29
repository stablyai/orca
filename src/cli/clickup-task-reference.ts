import { parseClickUpTaskInput } from '../shared/clickup-task-url'

export type ClickUpParsedTaskReference = {
  taskId: string
  workspaceId?: string
}

export function parseClickUpTaskReference(value: string): ClickUpParsedTaskReference | null {
  const input = value.trim()
  if (!input) {
    return null
  }
  const parsed = parseClickUpTaskInput(input)
  if (parsed) {
    return {
      taskId: parsed.taskId,
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {})
    }
  }
  return /^[0-9a-z]{6,24}$/.test(input) ? { taskId: input } : null
}

export const parseClickUpTaskTarget = parseClickUpTaskReference
