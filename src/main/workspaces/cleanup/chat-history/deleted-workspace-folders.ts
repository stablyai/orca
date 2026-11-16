import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { isENOENT } from '../../../ipc/filesystem/access/filesystem-path-containment'
import { managedWorktreeDirectories } from '../../../ai-vault-search/scope/session-search-scope-paths'
import { listWorkspaceCleanupOwnedRepos } from '../workspace-cleanup-run-evidence'

export type PathState = 'directory' | 'missing' | 'other'

export async function readPathState(path: string): Promise<PathState> {
  try {
    return (await lstat(path)).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    // Only proven absence counts: a permission or I/O error must never read as a deleted workspace.
    return isENOENT(error) ? 'missing' : 'other'
  }
}

/**
 * Directories whose children are this host's Orca workspaces, deepest first so a session matches
 * the parent that holds its workspace. Shared flat roots are left out: they hold folders Orca never made.
 */
export function workspaceParentDirectories(store: RuntimeStore): string[] {
  const settings = store.getSettings()
  const repoPaths = store.getRepos().map((repo) => repo.path)
  const seen = new Set<string>()
  const directories: string[] = []
  for (const repo of listWorkspaceCleanupOwnedRepos(store).values()) {
    for (const directory of managedWorktreeDirectories(repo, settings)) {
      const key = normalizeRuntimePathForComparison(directory)
      if (
        seen.has(key) ||
        // A WSL distro's transcripts carry Linux paths this process cannot check for absence.
        parseWslUncPath(directory) ||
        // A `..` project base or a nested root that is a checkout also holds the user's own folders.
        repoPaths.some((repoPath) => isPathInsideOrEqual(directory, repoPath))
      ) {
        continue
      }
      seen.add(key)
      directories.push(directory)
    }
  }
  return directories.sort((left, right) => right.length - left.length)
}

/** The workspace folder a path sits in: its first segment under a workspace parent directory. */
export function workspaceFolderOf(
  paths: readonly (string | null | undefined)[],
  parents: readonly string[]
): { parent: string; folder: string } | null {
  for (const path of paths) {
    if (!path) {
      continue
    }
    for (const parent of parents) {
      // relativePathInsideRoot returns `/`-separated suffixes; `\` is a legal POSIX name character.
      const name = relativePathInsideRoot(parent, path)?.split('/')[0]
      if (name) {
        return { parent, folder: resolveRuntimePath(parent, name) }
      }
    }
  }
  return null
}

/** Resolves symlinked parents (macOS /tmp is /private/tmp) so two spellings of one folder compare equal. */
export class FolderSpellings {
  private readonly realParents = new Map<string, Promise<string | null>>()

  private realParent(path: string): Promise<string | null> {
    const parent = dirname(path)
    let real = this.realParents.get(parent)
    if (!real) {
      real = realpath(parent).catch(() => null)
      this.realParents.set(parent, real)
    }
    return real
  }

  async of(path: string): Promise<string[]> {
    const real = await this.realParent(path)
    const spellings = [normalizeRuntimePathForComparison(path)]
    if (real) {
      spellings.push(normalizeRuntimePathForComparison(resolveRuntimePath(real, basename(path))))
    }
    return spellings
  }
}

/** Every spelling of each path Orca still lists: an archived workspace keeps its row while its folder is gone. */
export async function listedWorkspaceSpellings(
  store: RuntimeStore,
  spellings: FolderSpellings
): Promise<string[]> {
  const paths = store.getRepos().map((repo) => repo.path)
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (path) {
      paths.push(path)
    }
  }
  return (await Promise.all(paths.map((path) => spellings.of(path)))).flat()
}

/** A folder holding any listed path, even a nested archived one, is not a deleted workspace. */
export function holdsListedPath(
  folderSpellings: readonly string[],
  listed: readonly string[]
): boolean {
  return folderSpellings.some((folder) =>
    listed.some((listedPath) => isPathInsideOrEqual(folder, listedPath))
  )
}
