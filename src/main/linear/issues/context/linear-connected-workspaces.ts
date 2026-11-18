import type { LinearWorkspace } from '../../../../shared/linear/workspace-types'
import { getConnectedWorkspaces } from './issue-context-resolution'
import { linearNotConnectedError } from './linear-not-connected-error'

/** The connected workspaces, or the gap line when there are none. */
export function requireConnectedWorkspaces(): LinearWorkspace[] {
  const workspaces = getConnectedWorkspaces()
  if (workspaces.length === 0) {
    throw linearNotConnectedError()
  }
  return workspaces
}
