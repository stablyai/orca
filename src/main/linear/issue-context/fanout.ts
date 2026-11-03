import type { LinearErrorCode } from '../../../shared/linear/agent-access'
import type { LinearWorkspaceCandidate } from '../../../shared/linear/agent-result-types'
import type { LinearWorkspace } from '../../../shared/linear/workspace-types'
import { getClients, getStatus, type LinearClientForWorkspace } from '../client'
import { toLinearAccessError, type LinearAgentAccessError } from './errors'

export type WorkspaceReadFailure = {
  workspace: LinearWorkspaceCandidate
  code: LinearErrorCode
  message: string
  error: LinearAgentAccessError
}

export function getFanoutClientEntries(signal?: AbortSignal): {
  entries: LinearClientForWorkspace[]
  failures: WorkspaceReadFailure[]
} {
  const workspaces = getStatus().workspaces ?? []
  if (workspaces.length === 0) {
    return { entries: getClients('all', signal), failures: [] }
  }

  const entries: LinearClientForWorkspace[] = []
  const failures: WorkspaceReadFailure[] = []
  for (const workspace of workspaces) {
    try {
      const entry = getClients(workspace.id, signal)[0]
      if (entry) {
        entries.push(entry)
      }
    } catch (error) {
      const failure = workspaceFailure(workspace, toLinearAccessError(error))
      failures.push(failure)
      console.warn('[linear] agent workspace credential read failed:', error)
    }
  }
  return { entries, failures }
}

export function workspaceFailure(
  workspace: LinearWorkspace,
  error: LinearAgentAccessError
): WorkspaceReadFailure {
  return {
    workspace: {
      id: workspace.id,
      name: workspace.organizationName
    },
    code: error.code,
    message: error.message,
    error
  }
}
