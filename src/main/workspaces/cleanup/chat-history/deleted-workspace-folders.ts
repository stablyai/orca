import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { buildKnownOrcaWorkspaceLayouts } from '../../../../shared/worktree/visibility/ownership'
import { isENOENT } from '../../../ipc/filesystem/access/filesystem-path-containment'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { listWorkspaceCleanupOwnedRepos } from '../workspace-cleanup-run-evidence'

// Folders are compared by filesystem identity, so symlinks, case and Unicode spellings are the OS's call.
type Identity = string

async function identityOf(path: string): Promise<Identity | null> {
  return stat(path).then(
    (stats) => (stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null),
    () => null
  )
}

/** Whether the path exists: a permission or I/O error is `unknown`, never absence. */
async function presence(path: string): Promise<'present' | 'missing' | 'unknown'> {
  return lstat(path).then(
    () => 'present' as const,
    (error: unknown) => (isENOENT(error) ? 'missing' : 'unknown')
  )
}

/** A gone folder: the deepest existing ancestor of a path and the first missing name below it. */
export type GoneFolder = { ancestor: string; ancestorId: Identity; name: string }

/** Null when the path exists or its state can't be proven; byte-exact, never re-spelled. */
export async function goneFolderOf(path: string): Promise<GoneFolder | null> {
  let current = path
  let name: string | null = null
  for (;;) {
    const state = await presence(current)
    if (state === 'unknown') {
      return null
    }
    if (state === 'present') {
      const ancestorId = name === null ? null : await identityOf(current)
      return name !== null && ancestorId ? { ancestor: current, ancestorId, name } : null
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    name = basename(current)
    current = parent
  }
}

// macOS and Windows names usually ignore case and Unicode form, so protection compares them folded.
const foldName = (name: string): string =>
  process.platform === 'linux' ? name : name.normalize('NFC').toLowerCase()

export function goneFolderKey(folder: GoneFolder): string {
  return `${folder.ancestorId}/${foldName(folder.name)}`
}

/** What Orca still lists: checkouts, folder projects, workspaces and renamed workspaces' earlier paths. */
function listedPaths(store: RuntimeStore): string[] {
  const paths = store.getRepos().map((repo) => repo.path)
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
  return paths
}

export type ListedFolders = {
  /** Existing listed folders, by identity. */
  present: Set<Identity>
  /** Missing listed paths, as the gone folder that holds them (an archived workspace keeps its row). */
  gone: Set<string>
}

export async function readListedFolders(store: RuntimeStore): Promise<ListedFolders> {
  const listed: ListedFolders = { present: new Set(), gone: new Set() }
  for (const path of new Set(listedPaths(store))) {
    const id = await identityOf(path)
    if (id) {
      listed.present.add(id)
      continue
    }
    const gone = await goneFolderOf(path)
    if (gone) {
      listed.gone.add(goneFolderKey(gone))
    }
  }
  return listed
}

/** Whether the folder or any ancestor is something Orca still lists, such as a flat workspace named like a repo. */
async function isInsideListedFolder(directory: string, listed: ListedFolders): Promise<boolean> {
  let current = directory
  for (;;) {
    const id = await identityOf(current)
    if (id && listed.present.has(id)) {
      return true
    }
    const parent = dirname(current)
    if (parent === current) {
      return false
    }
    current = parent
  }
}

/**
 * `<workspaces root>/<repo name>` for each nested layout Orca has used: the only folders whose
 * children are Orca workspaces. Flat roots and a project's flat base also hold folders Orca never
 * made (other tools' worktrees, the user's projects), and a folder with `.git` is a checkout.
 */
export async function readWorkspaceParents(
  store: RuntimeStore,
  listed: ListedFolders
): Promise<{ scopePaths: string[]; ids: Set<Identity> }> {
  const settings = store.getSettings()
  const scopePaths: string[] = []
  const ids = new Set<Identity>()
  for (const repo of listWorkspaceCleanupOwnedRepos(store).values()) {
    const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
    // A WSL distro's transcripts carry Linux paths this process cannot check for absence.
    if (!repoName || parseWslUncPath(repo.path)) {
      continue
    }
    for (const layout of buildKnownOrcaWorkspaceLayouts(settings, repo)) {
      if (!layout.nestWorkspaces || parseWslUncPath(layout.path)) {
        continue
      }
      const directory = join(layout.path, repoName)
      const id = await identityOf(directory)
      if (
        !id ||
        ids.has(id) ||
        (await presence(join(directory, '.git'))) !== 'missing' ||
        (await isInsideListedFolder(directory, listed))
      ) {
        continue
      }
      ids.add(id)
      // Scope both spellings: agents record the physical cwd, settings hold the configured one.
      scopePaths.push(directory)
      const real = await realpath(directory).catch(() => null)
      if (real && real !== directory) {
        scopePaths.push(real)
      }
    }
  }
  return { scopePaths, ids }
}

/** Re-reads the gone folder right before deletion: the volume may be gone or the folder recreated. */
export async function isStillGone(folder: GoneFolder): Promise<boolean> {
  return (
    (await identityOf(folder.ancestor)) === folder.ancestorId &&
    (await presence(join(folder.ancestor, folder.name))) === 'missing'
  )
}
