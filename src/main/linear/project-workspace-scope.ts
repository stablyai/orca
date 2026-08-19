import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { getClients, getStatus, type LinearClientForWorkspace } from './client'
import { linearError, type LinearAgentAccessError } from './issue-context-errors'
import { getFanoutClientEntries } from './issue-context-fanout'

const LIST_WORKSPACES_STEP =
  'Run `orca linear project list --workspace all --json` to see workspace ids.'

export function connectedLinearWorkspaces(): LinearWorkspace[] {
  return getStatus().workspaces ?? []
}

/**
 * Clients for one workspace, or every connected workspace when unscoped.
 * `all` is rejected here: a single project target cannot fan out its result.
 */
export function selectLinearProjectWorkspaces(
  workspaceId: string | undefined,
  action: string
): LinearClientForWorkspace[] {
  if (workspaceId === 'all') {
    throw linearError(
      'linear_invalid_workspace',
      `Pass a single --workspace id for ${action}; \`all\` is only valid for list, statuses, and labels.`,
      { nextSteps: [LIST_WORKSPACES_STEP] }
    )
  }
  const workspaces = connectedLinearWorkspaces()
  if (workspaceId && workspaces.length > 0 && !workspaces.some(({ id }) => id === workspaceId)) {
    throw unknownLinearWorkspace(workspaceId)
  }
  const entries = workspaceId ? getClients(workspaceId) : unscopedProjectEntries()
  if (entries.length === 0) {
    if (workspaceId) {
      throw unknownLinearWorkspace(workspaceId)
    }
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the project read.']
    })
  }
  return entries
}

// Why: an unreadable workspace is a failed lookup, not an absent one — a partial
// fan-out could never prove that a target is unique.
function unscopedProjectEntries(): LinearClientForWorkspace[] {
  const { entries, failures } = getFanoutClientEntries()
  if (failures[0]) {
    throw failures[0].error
  }
  return entries
}

/** Linear URL workspace segment → the one connected workspace that owns it. */
export function resolveLinearWorkspaceByUrlKey(urlKey: string): LinearWorkspace {
  const normalized = urlKey.toLowerCase()
  const matches = connectedLinearWorkspaces().filter(
    (workspace) => workspace.organizationUrlKey?.toLowerCase() === normalized
  )
  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length === 0) {
    throw linearError(
      'linear_invalid_workspace',
      `Linear workspace "${urlKey}" from the project URL is not connected.`,
      { nextSteps: ['Connect that Linear workspace, or retry with a project id and --workspace.'] }
    )
  }
  throw linearError(
    'linear_invalid_workspace',
    `Linear workspace "${urlKey}" matches more than one connected workspace.`,
    {
      candidates: matches.map((workspace) => ({
        id: workspace.id,
        name: workspace.organizationName
      })),
      nextSteps: matches.map((workspace) => `Retry with --workspace ${workspace.id}.`)
    }
  )
}

export function assertLinearUrlWorkspaceMatches(
  workspace: LinearWorkspace,
  workspaceId: string | undefined
): void {
  if (!workspaceId || workspaceId === workspace.id) {
    return
  }
  throw linearError(
    'linear_invalid_workspace',
    'The project URL and --workspace point at different Linear workspaces.',
    {
      nextSteps: [
        `Retry with --workspace ${workspace.id} for ${workspace.organizationName}, or pass a URL from the selected workspace.`
      ]
    }
  )
}

export function unknownLinearWorkspace(workspaceId: string): LinearAgentAccessError {
  return linearError('linear_invalid_workspace', `Unknown Linear workspace ${workspaceId}.`, {
    nextSteps: [LIST_WORKSPACES_STEP]
  })
}
