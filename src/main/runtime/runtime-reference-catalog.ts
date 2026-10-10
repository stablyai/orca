import type { RuntimeStore } from './runtime-store-contract'
import type {
  ReferenceWorkspace,
  RuntimeReferenceListResult
} from '../../shared/runtime-reference-contracts'
import type { Worktree } from '../../shared/worktree/types'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from '../../shared/worktree/id'
import { getWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import {
  getWorkspaceAttachments,
  matchesLegacyWorkspaceAttachment
} from '../../shared/workspace-attachments'
import { legacyWorkspaceAttachments } from '../../shared/workspace-attachment-legacy'
import { getWorkspaceReferenceIdentity } from '../../shared/workspace-reference-identity'
import {
  isPathInsideOrEqual,
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath
} from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { branchSelectorMatches, runtimePathsEqual } from './runtime-worktree-path-identity'

export function listReferenceWorkspaces(
  store: Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getAllWorktreeMeta'
    | 'getAllWorktreeMetaForHost'
    | 'getProjectGroups'
    | 'getFolderWorkspaces'
  >,
  cached: readonly Worktree[] = []
): ReferenceWorkspace[] {
  const repos = store.getRepos()
  const ownerCounts = new Map<string, number>()
  for (const repo of repos) {
    ownerCounts.set(repo.id, (ownerCounts.get(repo.id) ?? 0) + 1)
  }
  const snapshots = new Map(
    [...new Set(repos.map(getRepoExecutionHostId))].map((host) => [
      host,
      readAllWorktreeMetaForHost(store, host)
    ])
  )
  const cachedByIdentity = new Map(cached.map((row) => [getWorktreeHostIdentity(row), row]))
  const reposByIdentity = new Map(
    repos.map((repo) => [
      getWorktreeHostIdentity({
        id: repo.id,
        hostId: getRepoExecutionHostId(repo)
      }),
      repo
    ])
  )
  const result: ReferenceWorkspace[] = []
  for (const [hostId, metadata] of snapshots) {
    for (const [id, meta] of Object.entries(metadata)) {
      const parsed = splitWorktreeIdForFilesystem(id)
      if (!parsed) {
        continue
      }
      const repo = reposByIdentity.get(getWorktreeHostIdentity({ id: parsed.repoId, hostId }))
      if (!repo) {
        continue
      }
      if (!meta.hostId && (ownerCounts.get(repo.id) ?? 0) > 1) {
        continue
      }
      const previous = cachedByIdentity.get(getWorktreeHostIdentity({ id, hostId }))
      const worktree = mergeWorktree(
        repo.id,
        {
          path: parsed.worktreePath,
          head: previous?.head ?? '',
          branch: previous?.branch ?? '',
          isBare: previous?.isBare ?? false,
          isMainWorktree: runtimePathsEqual(parsed.worktreePath, repo.path)
        },
        { ...meta, hostId },
        repo.displayName
      )
      result.push({
        ...worktree,
        id,
        kind: 'worktree',
        name: worktree.displayName,
        repo: repo.displayName,
        linkedItems: getWorkspaceAttachments(worktree)
      })
    }
  }
  const known = new Set(result.map(getWorktreeHostIdentity))
  for (const worktree of cached) {
    const repo = reposByIdentity.get(
      getWorktreeHostIdentity({ id: worktree.repoId, hostId: worktree.hostId })
    )
    if (!repo || known.has(getWorktreeHostIdentity(worktree))) {
      continue
    }
    result.push({
      ...worktree,
      kind: 'worktree',
      name: worktree.displayName,
      repo: repo.displayName,
      linkedItems: getWorkspaceAttachments(worktree)
    })
  }
  const groups = new Map((store.getProjectGroups?.() ?? []).map((group) => [group.id, group]))
  for (const folder of store.getFolderWorkspaces?.() ?? []) {
    const worktree = folderWorkspaceToWorktree(folder)
    result.push({
      ...worktree,
      kind: 'folder',
      name: folder.name,
      repo: groups.get(folder.projectGroupId)?.name ?? folder.projectGroupId,
      linkedItems: getWorkspaceAttachments(worktree)
    })
  }
  return result
}

export function listWorkspaceReferences(worktree: ReferenceWorkspace): RuntimeReferenceListResult {
  const selected = legacyWorkspaceAttachments(worktree)
  return {
    worktree,
    references: getWorkspaceAttachments(worktree).map((item) => ({
      ...item,
      key: getWorkspaceReferenceIdentity(item),
      selected: selected.some((legacy) => matchesLegacyWorkspaceAttachment(item, legacy))
    }))
  }
}

export function selectReferenceWorkspace(
  workspaces: readonly ReferenceWorkspace[],
  selector: string,
  cwd?: string
): ReferenceWorkspace {
  let matches: ReferenceWorkspace[]
  if (selector === 'current') {
    if (!cwd) {
      throw new Error('Current workspace requires a local working directory')
    }
    matches = workspaces.filter(
      (row) => row.hostId === 'local' && isPathInsideOrEqual(row.path, cwd)
    )
    const longest = Math.max(...matches.map((row) => row.path.length))
    matches = matches.filter((row) => row.path.length === longest)
  } else if (selector.startsWith('identity:')) {
    matches = workspaces.filter((row) => row.identity?.key === selector.slice(9))
  } else if (selector.startsWith('id:')) {
    matches = workspaces.filter((row) => worktreeIdsEqual(row.id, selector.slice(3)))
  } else if (selector.startsWith('name:')) {
    matches = workspaces.filter((row) => row.name === selector.slice(5))
  } else if (selector.startsWith('path:')) {
    const path = selector.slice(5)
    const distro = cwd ? parseWslUncPath(cwd)?.distro : undefined
    const linuxPath = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')
    matches = workspaces.filter(
      (row) =>
        runtimePathsEqual(row.path, path) ||
        (cwd &&
          linuxPath &&
          row.hostId === 'local' &&
          (isWslUncPathForLinuxMountedPath(row.path, path) ||
            (distro && isWslUncPathForCallerLinuxPath(row.path, path, distro))))
    )
  } else if (selector.startsWith('branch:')) {
    matches = workspaces.filter(
      (row) => row.branch && branchSelectorMatches(row.branch, selector.slice(7))
    )
  } else if (selector.startsWith('issue:')) {
    matches = workspaces.filter(
      (row) => typeof row.linkedIssue === 'number' && String(row.linkedIssue) === selector.slice(6)
    )
  } else {
    matches = workspaces.filter(
      (row) =>
        row.id === selector ||
        runtimePathsEqual(row.path, selector) ||
        (row.branch && branchSelectorMatches(row.branch, selector))
    )
  }
  // Why: duplicate registrations on one host describe one path; identical paths on different hosts do not.
  if (
    (selector === 'current' || selector.startsWith('path:')) &&
    matches.length > 1 &&
    new Set(matches.map((row) => row.hostId)).size === 1
  ) {
    return matches[0]
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'selector_ambiguous' : 'selector_not_found')
  }
  return matches[0]
}
