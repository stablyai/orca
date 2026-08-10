import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'

type DeclaredHostOwner = {
  executionHostId?: string | null
  connectionId?: string | null
}

export function declaredFolderHostId(
  workspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId | null {
  const workspaceHostIds = workspaces.map(declaredFolderOwnerHostId)
  if (workspaceHostIds.some(Boolean)) {
    return consistentFolderHostId(workspaceHostIds)
  }
  const projectGroupIds = new Set(workspaces.map((workspace) => workspace.projectGroupId))
  return consistentFolderHostId(
    projectGroups.filter((group) => projectGroupIds.has(group.id)).map(declaredFolderOwnerHostId)
  )
}

function consistentFolderHostId(
  hostIds: readonly (ExecutionHostId | null)[]
): ExecutionHostId | null {
  if (hostIds.length === 0 || hostIds.some((hostId) => hostId === null)) {
    return null
  }
  const uniqueHostIds = new Set(hostIds)
  return uniqueHostIds.size === 1 ? (uniqueHostIds.values().next().value ?? null) : null
}

export function declaredFolderOwnerHostId(owner: DeclaredHostOwner): ExecutionHostId | null {
  const hasExecutionHost = owner.executionHostId !== null && owner.executionHostId !== undefined
  const executionHost = hasExecutionHost ? parseExecutionHostId(owner.executionHostId) : null
  if (hasExecutionHost && !executionHost) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  const connectionId = owner.connectionId?.trim() || null
  if (owner.connectionId !== null && owner.connectionId !== undefined && !connectionId) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
  if (executionHost && connectionHostId && executionHost.id !== connectionHostId) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  return executionHost?.id ?? connectionHostId
}
