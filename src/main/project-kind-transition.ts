import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { isFolderRepo } from '../shared/repo-kind'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeIdForFilesystem
} from '../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'

/**
 * A folder project's extra workspaces are `worktreeMeta` rows keyed
 * `<repoId>::<path>::workspace:<uuid>`, and only the folder branch of the worktree listing knows
 * those keys exist. Flipping `kind` to `git` moves the repo onto the git branch, which lists
 * `git worktree list` — one path — so those workspaces stop being listed at all.
 */
export function folderProjectHasExtraWorkspaces(
  allWorktreeMeta: Readonly<Record<string, WorktreeMeta>>,
  repo: Pick<Repo, 'id' | 'path'>
): boolean {
  // Compare the parsed path, not a raw prefix: a stored id can spell the root with a different case
  // or separator than the repo row does, and a raw `startsWith` would miss those workspaces and
  // report a project as safe to upgrade when it is not.
  const repoPathKey = normalizeRuntimePathForComparison(repo.path)
  return Object.keys(allWorktreeMeta).some((key) => {
    if (!key.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
      return false
    }
    const parsed = splitWorktreeIdForFilesystem(key)
    return (
      parsed?.repoId === repo.id &&
      normalizeRuntimePathForComparison(parsed.worktreePath) === repoPathKey
    )
  })
}

/**
 * Whether a project may move from `folder` to `git` right now.
 *
 * Two writers change a project's kind — the `.git` upgrade watch and a project host setup update —
 * and both must reach the same verdict, or the setup path silently does what the watch refuses.
 * Returns null when the transition is allowed, or the reason it is not.
 */
export function refuseFolderProjectGitUpgradeReason(
  allWorktreeMeta: Readonly<Record<string, WorktreeMeta>>,
  repo: Pick<Repo, 'id' | 'path' | 'kind'>
): string | null {
  if (!isFolderRepo(repo)) {
    return null
  }
  return folderProjectHasExtraWorkspaces(allWorktreeMeta, repo)
    ? 'This project has folder workspaces that a Git project cannot list. Remove them before turning it into a Git project.'
    : null
}
