import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  createNormalizedPathInsideOrEqualMatcher,
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
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

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
export async function workspaceParentDirectories(
  store: RuntimeStore,
  listed: ListedPaths,
  spellings: FolderSpellings
): Promise<string[]> {
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
      if (
        seen.has(key) ||
        // A nested root that is or holds a checkout (a `..` base) also holds the user's own folders.
        repoPaths.some((repoPath) => isPathInsideOrEqual(directory, repoPath)) ||
        // A live flat workspace named like a repo: its subfolders are not workspaces.
        (await spellings.of(directory)).some((parent) =>
          listed.workspaces.some((workspace) => isPathInsideOrEqual(workspace, parent))
        )
      ) {
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

/** Normalized spellings of every checkout and workspace path Orca still lists. */
export type ListedPaths = { repos: string[]; workspaces: string[]; all: string[] }

/** Every path Orca still lists, renamed workspaces' earlier paths included: their chats are still theirs. */
export async function listedWorkspaceSpellings(
  store: RuntimeStore,
  spellings: FolderSpellings
): Promise<ListedPaths> {
  const paths: string[] = []
  for (const folderWorkspace of store.getFolderWorkspaces?.() ?? []) {
    paths.push(folderWorkspace.folderPath)
  }
  // The legacy map can drop a local row that shares its id with a removed remote one.
  const metas = [
    ...Object.entries(store.getAllWorktreeMeta()),
    ...Object.entries(readAllWorktreeMetaForHost(store, LOCAL_EXECUTION_HOST_ID))
  ]
  for (const [worktreeId, meta] of metas) {
    for (const id of [worktreeId, ...(meta.priorWorktreeIds ?? [])]) {
      const path = splitWorktreeId(id)?.worktreePath
      if (path) {
        paths.push(path)
      }
    }
  }
  const spell = async (list: string[]): Promise<string[]> =>
    (await Promise.all(list.map((path) => spellings.of(path)))).flat()
  const repos = await spell(store.getRepos().map((repo) => repo.path))
  const workspaces = await spell(paths)
  return { repos, workspaces, all: [...new Set([...repos, ...workspaces])] }
}

/** A folder holding any listed path, even a nested archived one, is not a deleted workspace. */
export function holdsListedPath(folderSpellings: readonly string[], listed: ListedPaths): boolean {
  return folderSpellings.some((folder) => {
    // Both sides are already normalized; this runs on the main thread for every deleted folder.
    const holds = createNormalizedPathInsideOrEqualMatcher(folder)
    return listed.all.some(holds)
  })
}
