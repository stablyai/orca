import type { LinearWorkspaceCandidate } from '../../shared/linear-agent-access'
import type { LinearWorkspace } from '../../shared/types'
import { linearError } from './issue-context-errors'

export function resolveWorkspaceSelector(
  selectors: {
    workspaceId?: string | null
    organizationUrlKey?: string | null
  },
  workspaces: LinearWorkspace[]
): LinearWorkspace | null {
  if (workspaces.length === 0) {
    return null
  }
  const byId = selectors.workspaceId
    ? workspaces.find((workspace) => workspace.id === selectors.workspaceId)
    : null
  const byOrg = selectors.organizationUrlKey
    ? workspaces.find((workspace) => workspace.organizationUrlKey === selectors.organizationUrlKey)
    : null

  if (selectors.workspaceId && !byId) {
    throw unknownWorkspace(selectors.workspaceId)
  }
  if (selectors.organizationUrlKey && !byOrg) {
    throw linearError(
      'linear_invalid_workspace',
      `Linear organization ${selectors.organizationUrlKey} is not connected.`,
      {
        nextSteps: ['Connect that Linear workspace or pass --workspace for a connected workspace.']
      }
    )
  }
  if (byId && byOrg && byId.id !== byOrg.id) {
    throw linearError('linear_invalid_workspace', 'The issue URL and --workspace do not match.', {
      nextSteps: [
        `Retry with --workspace ${byOrg.id} or use an issue URL from ${byId.organizationName}.`
      ]
    })
  }
  return byId ?? byOrg ?? null
}

export function unknownWorkspace(workspaceId: string): ReturnType<typeof linearError> {
  return linearError('linear_invalid_workspace', `Unknown Linear workspace ${workspaceId}.`, {
    nextSteps: ['Run `orca linear search <query> --workspace all --json` to inspect workspace ids.']
  })
}

export function ambiguousWorkspace(
  workspaces: LinearWorkspace[],
  identifier: string
): ReturnType<typeof linearError> {
  const candidates: LinearWorkspaceCandidate[] = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.organizationName
  }))
  return linearError(
    'linear_workspace_ambiguous',
    `Linear issue ${identifier} exists in more than one workspace.`,
    {
      candidates,
      nextSteps: candidates.map(
        (candidate) => `Retry with --workspace ${candidate.id} for ${candidate.name}.`
      )
    }
  )
}
