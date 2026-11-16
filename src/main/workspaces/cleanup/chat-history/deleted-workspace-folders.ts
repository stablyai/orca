import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { buildKnownOrcaWorkspaceLayouts } from '../../../../shared/worktree/visibility/ownership'
import { isENOENT } from '../../../ipc/filesystem/access/filesystem-path-containment'
import { listWorkspaceCleanupOwnedRepos } from '../workspace-cleanup-run-evidence'

/** True when the folder is provably gone; a permission or I/O error never reads as deleted. */
export async function isMissing(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: unknown) => isENOENT(error)
  )
}

/** A parent counts only while mounted; a symlinked workspaces root follows its target. */
export async function isMountedDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isDirectory(),
    () => false
  )
}

/**
 * `<workspaces root>/<repo name>` for each nested layout Orca has used, in the configured and the
 * resolved spelling, deepest first. Flat roots and a project's own flat base also hold folders Orca
 * never made (other tools' worktrees, the user's projects), so they are left out.
 */
export async function workspaceParentDirectories(store: RuntimeStore): Promise<string[]> {
  const settings = store.getSettings()
  const repoPaths = store.getRepos().map((repo) => repo.path)
  const candidates: string[] = []
  for (const repo of listWorkspaceCleanupOwnedRepos(store).values()) {
    const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
    // A WSL distro's transcripts carry Linux paths this process cannot check for absence.
    if (!repoName || parseWslUncPath(repo.path)) {
      continue
    }
    for (const layout of buildKnownOrcaWorkspaceLayouts(settings, repo)) {
      if (layout.nestWorkspaces && !parseWslUncPath(layout.path)) {
        candidates.push(join(layout.path, repoName))
      }
    }
  }
  const seen = new Set<string>()
  const directories: string[] = []
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => null)
    for (const directory of real ? [candidate, real] : [candidate]) {
      const key = normalizeRuntimePathForComparison(directory)
      // A nested root that is or holds a checkout (a `..` base) also holds the user's own folders.
      if (seen.has(key) || repoPaths.some((repoPath) => isPathInsideOrEqual(directory, repoPath))) {
        continue
      }
      seen.add(key)
      directories.push(directory)
    }
  }
  return directories.sort((left, right) => right.length - left.length)
}

/** The workspace folder a session ran in: its cwd's first segment under a workspace parent. */
export function workspaceFolderOf(
  cwd: string | null,
  parents: readonly string[]
): { parent: string; folder: string } | null {
  if (!cwd) {
    return null
  }
  for (const parent of parents) {
    // `/`-separated suffix; joined with the host's own rules so a POSIX `\` stays part of the name.
    const name = relativePathInsideRoot(parent, cwd)?.split('/')[0]
    if (name) {
      return { parent, folder: join(parent, name) }
    }
  }
  return null
}

// macOS and Windows volumes usually ignore case, so protection compares case-folded there.
const FOLD_CASE = process.platform !== 'linux'

/** Spellings of one path to compare: as written, and through its parent's real path (/tmp is /private/tmp). */
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
    return [path, ...(real ? [join(real, basename(path))] : [])].map((spelling) => {
      const key = normalizeRuntimePathForComparison(spelling)
      return FOLD_CASE ? key.toLowerCase() : key
    })
  }
}

/** Every path Orca still lists, renamed workspaces' earlier paths included: their chats are still theirs. */
export async function listedWorkspaceSpellings(
  store: RuntimeStore,
  spellings: FolderSpellings
): Promise<string[]> {
  const paths = store.getRepos().map((repo) => repo.path)
  for (const folderWorkspace of store.getFolderWorkspaces?.() ?? []) {
    paths.push(folderWorkspace.folderPath)
  }
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    for (const id of [worktreeId, ...(meta.priorWorktreeIds ?? [])]) {
      const path = splitWorktreeId(id)?.worktreePath
      if (path) {
        paths.push(path)
      }
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
