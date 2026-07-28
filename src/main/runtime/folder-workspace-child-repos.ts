import type { GitStatusEntry, GitStatusResult, Repo } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'

/**
 * A folder workspace is a container directory that is not itself a git repo; the
 * real repos live inside it. Git operations addressed to the workspace selector
 * must be routed to whichever child repo owns the requested path.
 */
export function listFolderWorkspaceChildRepos(repos: readonly Repo[], folderPath: string): Repo[] {
  const matching = repos
    .filter(
      (candidate) => !isFolderRepo(candidate) && isPathInsideOrEqual(folderPath, candidate.path)
    )
    .filter((candidate) => relativePathInsideRoot(folderPath, candidate.path) !== '')
    // Why: deepest first, measured on the normalized path. Raw length inverts when
    // two repos spell the same host differently — `\\wsl$\Ubuntu\repo\nested` (30)
    // is shorter than its own ancestor `\\wsl.localhost\Ubuntu\repo` (32), which
    // would route the nested repo's files to the ancestor.
    .sort(
      (left, right) =>
        normalizeRuntimePathForComparison(right.path).length -
        normalizeRuntimePathForComparison(left.path).length
    )
  // Why: the same directory can be registered twice (imported once directly and
  // once by a folder scan). Without this the merged status lists every file twice
  // and a commit runs against the repo twice.
  const byPath = new Map<string, Repo>()
  for (const repo of matching) {
    const key = normalizeRuntimePathForComparison(repo.path)
    if (!byPath.has(key)) {
      byPath.set(key, repo)
    }
  }
  return [...byPath.values()]
}

export type FolderWorkspaceChildRepoMatch = {
  repo: Repo
  /** `relativePath` rebased to be relative to `repo.path`. */
  rebasedRelativePath: string
}

/**
 * Resolve which child repo owns `relativePath` (given relative to the workspace
 * folder). Deepest match wins so a nested repo beats its ancestor.
 */
export function matchFolderWorkspaceChildRepo(
  repos: readonly Repo[],
  folderPath: string,
  relativePath: string | undefined,
  /** Pre-computed `listFolderWorkspaceChildRepos` result, so a bulk caller sorts once. */
  childRepos?: readonly Repo[]
): FolderWorkspaceChildRepoMatch | null {
  if (!relativePath) {
    return null
  }
  const absolutePath = resolveRuntimePath(folderPath, relativePath)
  // Why: a `..` segment must not silently resolve to a repo the user never opened.
  // Defense-in-depth today — the loop below only considers repos already inside
  // `folderPath`, so anything it could match is inside the folder anyway. This
  // stops that from being load-bearing if the candidate filter ever widens.
  if (relativePathInsideRoot(folderPath, absolutePath) === null) {
    return null
  }
  for (const repo of childRepos ?? listFolderWorkspaceChildRepos(repos, folderPath)) {
    if (!isPathInsideOrEqual(repo.path, absolutePath)) {
      continue
    }
    const rebasedRelativePath = relativePathInsideRoot(repo.path, absolutePath)
    if (rebasedRelativePath === null) {
      continue
    }
    // Why: the path names this repo's own root, so it addresses no file. Falling
    // through to an ancestor would rebase it as an ordinary path there — and a
    // discard then runs `git clean -ffdx` over the whole nested repo, deleting its
    // .git and any uncommitted work. Refuse rather than route it to the parent.
    if (rebasedRelativePath === '') {
      return null
    }
    return { repo, rebasedRelativePath }
  }
  return null
}

/** Prefix a child repo's status entry path so it stays addressable from the workspace root. */
export function prefixFolderWorkspaceEntryPath(
  folderPath: string,
  repoPath: string,
  entryPath: string
): string {
  const repoPrefix = relativePathInsideRoot(folderPath, repoPath)
  return repoPrefix ? `${repoPrefix}/${entryPath}` : entryPath
}

/**
 * Merge per-child-repo status into one workspace-level result. Entry paths are
 * rewritten workspace-relative so the renderer can address them with the same
 * selector it listed them under.
 */
export function mergeFolderWorkspaceGitStatus(
  folderPath: string,
  perRepo: readonly { repo: Repo; status: GitStatusResult }[]
): GitStatusResult {
  const entries: GitStatusEntry[] = []
  const ignoredPaths: string[] = []
  let didHitLimit = false
  let statusLength = 0
  for (const { repo, status } of perRepo) {
    const rebase = (path: string): string =>
      prefixFolderWorkspaceEntryPath(folderPath, repo.path, path)
    for (const entry of status.entries) {
      entries.push({
        ...entry,
        path: rebase(entry.path),
        ...(entry.oldPath ? { oldPath: rebase(entry.oldPath) } : {}),
        ...(entry.submoduleRoot ? { submoduleRoot: rebase(entry.submoduleRoot) } : {})
      })
    }
    for (const ignored of status.ignoredPaths ?? []) {
      ignoredPaths.push(rebase(ignored))
    }
    didHitLimit ||= status.didHitLimit === true
    statusLength += status.statusLength ?? status.entries.length
  }
  // Why: no single HEAD/branch/upstream describes N repos, so those stay unset
  // rather than reporting one child's state as the whole workspace's. The same
  // applies to a conflict: two repos mid-merge have no one answer, and picking
  // the first would offer an abort button that silently means "abort that one".
  const conflicted = perRepo.filter(({ status }) => status.conflictOperation !== 'unknown')
  return {
    entries,
    conflictOperation:
      conflicted.length === 1 ? conflicted[0]!.status.conflictOperation : 'unknown',
    ...(ignoredPaths.length > 0 ? { ignoredPaths } : {}),
    ...(didHitLimit ? { didHitLimit: true } : {}),
    statusLength
  }
}
