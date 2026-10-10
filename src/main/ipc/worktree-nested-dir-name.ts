import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { resolveWorktreeLayout } from '../../shared/worktree-layout'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import { getWorktreePathSettings, hasRepoWorktreeBasePath } from './worktree-logic'
import {
  getNestedRepoDirComparisonKey,
  getRepoFolderName,
  isWorkspaceDirRelativeToRepo
} from './worktree-workspace-root'

export type NestedDirNameRepo = Pick<
  Repo,
  'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId' | 'worktreeBasePath'
> &
  Partial<Pick<Repo, 'addedAt' | 'gitRemoteIdentity'>>

export type NestedDirNameSettings = Pick<
  GlobalSettings,
  'workspaceDir' | 'nestWorkspaces' | 'worktreeLayout'
>

type MirrorDistroForRepo<R> = (repo: R) => string | undefined

/**
 * Folder a repo nests its new worktrees under. It is the repo's folder name unless an
 * earlier-added repo on the same host already resolves to that `<root>/<name>`; then
 * `<name>-<owner>` from the remote identity, else `<name>-<first 8 id chars>`. Undefined when
 * the layout does not nest. Existing worktrees keep their stored paths either way.
 */
export function resolveNestedRepoDirName<R extends NestedDirNameRepo>(
  repo: R,
  repos: readonly R[],
  settings: NestedDirNameSettings,
  mirrorDistroForRepo?: MirrorDistroForRepo<R>
): string | undefined {
  if (resolveWorktreeLayout(settings) !== 'nested' || isFolderRepo(repo)) {
    return undefined
  }
  const name = getRepoFolderName(repo.path)
  // Why: only a repo whose folder name equals or prefix-extends this one can claim any of its
  // candidate names, so everyone else keeps the plain name without the full sweep.
  const hasCompetitor = repos.some(
    (peer) => peer.id !== repo.id && !isFolderRepo(peer) && areRelatedFolderNames(name, peer.path)
  )
  if (!hasCompetitor) {
    return name
  }
  const peers = repos.some((peer) => peer.id === repo.id) ? repos : [...repos, repo]
  return assignNestedRepoDirNames(peers, settings, mirrorDistroForRepo).get(repo.id) ?? name
}

/** Every git repo's nested folder, assigned in `addedAt` order so a later repo never renames an
 *  earlier one. Empty when the layout does not nest. */
export function assignNestedRepoDirNames<R extends NestedDirNameRepo>(
  repos: readonly R[],
  settings: NestedDirNameSettings,
  mirrorDistroForRepo?: MirrorDistroForRepo<R>
): Map<string, string> {
  const assigned = new Map<string, string>()
  if (resolveWorktreeLayout(settings) !== 'nested') {
    return assigned
  }
  const taken = new Set<string>()
  const ordered = repos.filter((repo) => !isFolderRepo(repo)).toSorted(compareByAddedAt)
  for (const repo of ordered) {
    const pathSettings = getWorktreePathSettings(repo, settings, mirrorDistroForRepo?.(repo))
    if (
      repo.connectionId &&
      !hasRepoWorktreeBasePath(repo) &&
      !isWorkspaceDirRelativeToRepo(repo.path, pathSettings.workspaceDir)
    ) {
      // Why: SSH ignores a desktop-absolute root and creates `<repo>-<name>` beside the repo.
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    const dirKey = (dirName: string): string =>
      `${hostId}\u0000${getNestedRepoDirComparisonKey(repo.path, pathSettings, dirName)}`
    const dirName =
      nestedDirNameCandidates(repo).find((candidate) => !taken.has(dirKey(candidate))) ??
      `${getRepoFolderName(repo.path)}-${repo.id}`
    taken.add(dirKey(dirName))
    assigned.set(repo.id, dirName)
  }
  return assigned
}

/** Store-owning callers: resolves peers and their WSL mirror distros the way create does. */
export function resolveStoreNestedRepoDirName(
  store: Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
    getRepos: () => readonly Repo[]
    getSettings: () => NestedDirNameSettings &
      Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
  },
  repo: Repo,
  settings: NestedDirNameSettings = store.getSettings()
): string | undefined {
  if (resolveWorktreeLayout(settings) !== 'nested') {
    return undefined
  }
  return resolveNestedRepoDirName(repo, store.getRepos(), settings, (peer) =>
    getWorktreeMirrorDistro(store, peer)
  )
}

function nestedDirNameCandidates(repo: NestedDirNameRepo): string[] {
  const name = getRepoFolderName(repo.path)
  const owner = remoteOwnerSlug(repo.gitRemoteIdentity?.canonicalKey)
  return [name, ...(owner ? [`${name}-${owner}`] : []), `${name}-${shortRepoId(repo.id)}`]
}

/** `github.com/acme/app` -> `acme`; `gitlab.com/group/sub/app` -> `group-sub`. */
export function remoteOwnerSlug(canonicalKey: string | null | undefined): string | null {
  const segments = canonicalKey?.split('/').slice(1, -1) ?? []
  const slug = segments
    // Why: Azure DevOps keys carry a literal `_git` segment between project and repo.
    .filter((segment) => segment && segment !== '_git')
    .join('-')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug || null
}

function shortRepoId(repoId: string): string {
  return (
    repoId
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 8)
      .toLowerCase() || 'repo'
  )
}

function areRelatedFolderNames(name: string, peerPath: string): boolean {
  // Why fold case: Windows roots compare case-insensitively; a false match only costs the sweep.
  const left = name.toLowerCase()
  const right = getRepoFolderName(peerPath).toLowerCase()
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`)
}

function compareByAddedAt(left: NestedDirNameRepo, right: NestedDirNameRepo): number {
  return (left.addedAt ?? 0) - (right.addedAt ?? 0) || left.id.localeCompare(right.id)
}
