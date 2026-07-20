import { RuntimeClientError } from '../runtime-client'

function parseClickUpTaskInput(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.hostname === 'app.clickup.com') {
      const match = url.pathname.match(/^\/t\/([^/]+)/)
      return match?.[1] ? decodeURIComponent(match[1]) : null
    }
  } catch {
    // Plain task IDs are handled below.
  }
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}

export function getOptionalClickUpTaskLinkFlag(
  flags: Map<string, string | boolean>,
  options: { allowNull?: boolean } = {}
): { linkedClickUpTaskId?: string | null; linkedClickUpWorkspaceId?: string | null } {
  if (!flags.has('clickup-task') && !flags.has('clickup-workspace')) {
    return {}
  }
  const workspace = flags.get('clickup-workspace')
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.trim())) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --clickup-workspace.')
  }
  const raw = flags.get('clickup-task')
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --clickup-task.')
  }
  if (raw === 'null') {
    if (!options.allowNull) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Omit --clickup-task on create; null is only valid for worktree set.'
      )
    }
    return { linkedClickUpTaskId: null, linkedClickUpWorkspaceId: null }
  }
  const taskId = parseClickUpTaskInput(raw.trim())
  if (!taskId) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--clickup-task must be a ClickUp task ID or app.clickup.com/t URL.'
    )
  }
  return {
    linkedClickUpTaskId: taskId,
    ...(typeof workspace === 'string' ? { linkedClickUpWorkspaceId: workspace.trim() } : {})
  }
}
