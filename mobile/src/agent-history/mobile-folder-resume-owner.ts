import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../src/shared/execution-host'
import {
  resolveDeclaredFolderScopeOwner,
  type DeclaredFolderScopeOwner
} from '../../../src/shared/folder-workspace-owner-resolution'

type MobileFolderOwner = {
  projectGroupId: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | string | null
}

type MobileProjectGroupOwner = {
  id: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | string | null
}

export function getMobileFolderScopeDeclaredHostId(scope: {
  connectionId?: string | null
  executionHostId?: ExecutionHostId | string | null
}): ExecutionHostId | null {
  const owner = getMobileFolderScopeDeclaredOwner(scope)
  return owner.status === 'owned' ? owner.executionHostId : null
}

function getMobileFolderScopeDeclaredOwner(scope: {
  connectionId?: string | null
  executionHostId?: ExecutionHostId | string | null
}): DeclaredFolderScopeOwner {
  return resolveDeclaredFolderScopeOwner(scope)
}

function getMobileProjectGroupOwner(scope: MobileProjectGroupOwner): DeclaredFolderScopeOwner {
  const owner = getMobileFolderScopeDeclaredOwner(scope)
  return owner.status === 'unknown'
    ? { status: 'owned', executionHostId: LOCAL_EXECUTION_HOST_ID }
    : owner
}

export function resolveMobileProjectGroupOwner<T extends MobileProjectGroupOwner>(
  candidates: readonly T[],
  preferredHostId: ExecutionHostId | null
): T | null {
  const owners = candidates.map(getMobileProjectGroupOwner)
  if (owners.some((owner) => owner.status === 'invalid')) {
    return null
  }
  if (preferredHostId) {
    const matching = candidates.filter(
      (_, index) =>
        owners[index]?.status === 'owned' && owners[index].executionHostId === preferredHostId
    )
    if (matching.length === 1) {
      return matching[0]!
    }
  }
  return candidates.length === 1 ? candidates[0]! : null
}

export function resolveMobileFolderOwner<T extends MobileFolderOwner>(
  candidates: readonly T[],
  projectGroups: readonly MobileProjectGroupOwner[],
  preferredHostId: ExecutionHostId | null
): T | null {
  const owners = candidates.map(getMobileFolderScopeDeclaredOwner)
  if (owners.some((owner) => owner.status === 'invalid')) {
    return null
  }
  const candidateGroupIds = new Set(candidates.map((candidate) => candidate.projectGroupId))
  if (
    projectGroups.some(
      (group) =>
        candidateGroupIds.has(group.id) && getMobileProjectGroupOwner(group).status === 'invalid'
    )
  ) {
    return null
  }
  if (!preferredHostId) {
    return candidates.length === 1 ? candidates[0]! : null
  }
  const matching = candidates.filter((candidate, index) => {
    const owner = owners[index]
    if (owner?.status === 'owned') {
      return owner.executionHostId === preferredHostId
    }
    return projectGroups.some((group) => {
      const groupOwner = getMobileProjectGroupOwner(group)
      return (
        group.id === candidate.projectGroupId &&
        groupOwner.status === 'owned' &&
        groupOwner.executionHostId === preferredHostId
      )
    })
  })
  return matching.length === 1 ? matching[0]! : null
}
