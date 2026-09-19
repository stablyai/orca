import type {
  PlaneComment,
  PlaneConnectionStatus,
  PlaneIssue,
  PlaneProject,
  PlaneState
} from '../shared/plane-types'

export function formatPlaneStatus(status: PlaneConnectionStatus): string {
  if (!status.connected) {
    return "Plane is not connected. Use 'orca plane connect --token <token>' to connect."
  }

  const lines = [
    `Connected to Plane (${status.instanceUrl})`,
    `Auth Type: ${status.authType}`,
    `User: ${status.viewer?.displayName ?? 'Unknown'}${status.viewer?.email ? ` (${status.viewer.email})` : ''}`,
    `Active Workspace: ${status.activeWorkspaceSlug ?? 'none'}`,
    `Workspaces: ${(status.workspaces ?? []).length} available`
  ]

  if (status.credentialError) {
    lines.push(`Warning: ${status.credentialError}`)
  }

  return lines.join('\n')
}

export function formatPlaneWorkspaceList(status: PlaneConnectionStatus): string {
  const workspaces = status.workspaces ?? []
  if (workspaces.length === 0) {
    return 'No Plane workspaces found.'
  }

  const header = `${'Slug'.padEnd(24)} ${'Name'.padEnd(30)} Active`
  const rows = workspaces.map((ws) => {
    const isActive = ws.slug === status.activeWorkspaceSlug ? '*' : ''
    return `${ws.slug.padEnd(24)} ${ws.name.padEnd(30)} ${isActive}`
  })

  return [header, ...rows].join('\n')
}

export function formatPlaneProjectList(projects: PlaneProject[]): string {
  if (projects.length === 0) {
    return 'No Plane projects found.'
  }

  const header = `${'Identifier'.padEnd(14)} ${'Name'.padEnd(32)} ID`
  const rows = projects.map((project) => {
    return `${project.identifier.padEnd(14)} ${project.name.padEnd(32)} ${project.id}`
  })

  return [header, ...rows].join('\n')
}

export function formatPlaneStateList(states: PlaneState[]): string {
  if (states.length === 0) {
    return 'No Plane workflow states found.'
  }

  const header = `${'Name'.padEnd(24)} ${'Group'.padEnd(16)} ID`
  const rows = states.map((state) => {
    return `${state.name.padEnd(24)} ${state.group.padEnd(16)} ${state.id}`
  })

  return [header, ...rows].join('\n')
}

export function formatPlaneIssueList(issues: PlaneIssue[]): string {
  if (issues.length === 0) {
    return 'No Plane issues found.'
  }

  return issues
    .map((issue) => {
      const state = `[${issue.state.name}]`.padEnd(16)
      const priority = issue.priority !== 'none' ? ` (${issue.priority})` : ''
      const assignees =
        issue.assignees.length > 0
          ? ` - ${issue.assignees.map((a) => a.displayName).join(', ')}`
          : ''
      return `${issue.key.padEnd(12)} ${state} ${issue.title}${priority}${assignees}`
    })
    .join('\n')
}

export function formatPlaneIssue(result: {
  issue: PlaneIssue
  comments?: PlaneComment[]
}): string {
  const { issue, comments } = result
  const lines = [
    `${issue.key}: ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state.name} (${issue.state.group})`,
    `Priority: ${issue.priority}`,
    `Project: ${issue.project.name} (${issue.project.identifier})`
  ]

  if (issue.assignees.length > 0) {
    lines.push(`Assignees: ${issue.assignees.map((a) => a.displayName).join(', ')}`)
  } else {
    lines.push('Assignees: unassigned')
  }

  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`)
  }

  if (issue.description) {
    // Strip simple HTML tags for plain text CLI output
    const cleanDesc = issue.description.replace(/<[^>]*>/g, '').trim()
    if (cleanDesc) {
      lines.push('', 'Description:', cleanDesc)
    }
  }

  if (comments && comments.length > 0) {
    lines.push('', `Comments (${comments.length}):`)
    for (const c of comments) {
      const author = c.author?.displayName ?? 'Unknown'
      const body = c.body.replace(/<[^>]*>/g, '').trim()
      lines.push(`  - ${author} (${c.createdAt.slice(0, 10)}): ${body}`)
    }
  }

  return lines.join('\n')
}

export function formatPlaneCreate(issue: PlaneIssue): string {
  return `Created ${issue.key}: ${issue.title} (${issue.url})`
}

export function formatPlaneStatusSet(result: { issueId: string; state: PlaneState }): string {
  return `Set issue ${result.issueId} state to ${result.state.name}.`
}

export function formatPlanePrioritySet(result: { issueId: string; priority: string }): string {
  return `Set issue ${result.issueId} priority to ${result.priority}.`
}

export function formatPlaneCommentAdd(result: { issueId: string }): string {
  return `Added comment to issue ${result.issueId}.`
}
