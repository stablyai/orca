import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

export type GroupMembershipSummary = {
  repoCount: number
  folderWorkspaceCount: number
  hasLocalOwner: boolean
  hasLocalFolderWorkspace: boolean
  hasUnconnectedRepo: boolean
  unsafeCycle: boolean
}

export type FolderScopeClassificationIndex = {
  groupMembership: ReadonlyMap<string, GroupMembershipSummary>
  legacyGroupMembership: ReadonlyMap<string, GroupMembershipSummary>
  allRepoPaths: readonly string[]
  localOwnerRepoPaths: readonly string[]
  unconnectedRepoPathsByOwner: ReadonlyMap<string, readonly string[]>
}

export function ownerGroupKey(ownerHostId: string, groupId: string): string {
  return `${ownerHostId}\0${groupId}`
}

export function emptyGroupMembershipSummary(): GroupMembershipSummary {
  return {
    repoCount: 0,
    folderWorkspaceCount: 0,
    hasLocalOwner: false,
    hasLocalFolderWorkspace: false,
    hasUnconnectedRepo: false,
    unsafeCycle: false
  }
}

function hasIndexedPathInside(rootPath: string, sortedPaths: readonly string[]): boolean {
  const root = normalizeRuntimePathForComparison(rootPath)
  const prefix = root === '/' || /^[a-z]:\/$/i.test(root) ? root : `${root}/`
  const lowerBound = (needle: string): number => {
    let low = 0
    let high = sortedPaths.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (sortedPaths[middle] < needle) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low
  }
  if (sortedPaths[lowerBound(root)] === root) {
    return true
  }
  return Boolean(sortedPaths[lowerBound(prefix)]?.startsWith(prefix))
}

export function isRemoteOnlyFolderScopeWithIndex(
  index: FolderScopeClassificationIndex,
  folderPath: string,
  projectGroupId: string,
  ownerHostId: string,
  inferLegacyOwner: boolean
): boolean {
  if (ownerHostId !== LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const summary =
    index.groupMembership.get(ownerGroupKey(ownerHostId, projectGroupId)) ??
    emptyGroupMembershipSummary()
  if (summary.unsafeCycle) {
    return true
  }
  if (inferLegacyOwner) {
    const legacySummary =
      index.legacyGroupMembership.get(projectGroupId) ?? emptyGroupMembershipSummary()
    if (legacySummary.unsafeCycle) {
      return true
    }
    const hasAnyCandidate =
      legacySummary.repoCount > 0 ||
      legacySummary.folderWorkspaceCount > 0 ||
      hasIndexedPathInside(folderPath, index.allRepoPaths)
    const hasLocalCandidate =
      legacySummary.hasLocalOwner ||
      legacySummary.hasLocalFolderWorkspace ||
      hasIndexedPathInside(folderPath, index.localOwnerRepoPaths)
    if (hasAnyCandidate && !hasLocalCandidate) {
      return true
    }
  }
  if (summary.repoCount === 0 && summary.folderWorkspaceCount === 0) {
    return false
  }
  if (summary.hasUnconnectedRepo || summary.hasLocalFolderWorkspace) {
    return false
  }
  return !hasIndexedPathInside(folderPath, index.unconnectedRepoPathsByOwner.get(ownerHostId) ?? [])
}
