import { parseClickUpTaskInput } from '../shared/clickup-task-url'

/**
 * Normalize a CLI task argument to the identifier ClickUp routes on.
 *
 * Delegates to the shared URL parser so the CLI, the composer, and worktree
 * linking agree on what a task reference is — notably that
 * `/t/<workspaceId>/<ABC-12>` names the custom id, not the Workspace.
 */
export function parseClickUpTaskReference(value: string): string | null {
  const input = value.trim()
  if (!input) {
    return null
  }
  const parsed = parseClickUpTaskInput(input)
  if (parsed) {
    return parsed.taskId
  }
  // A bare native task id never reaches the URL parser, which only accepts
  // URLs and custom ids.
  return /^[0-9a-z]{6,24}$/.test(input) ? input : null
}
