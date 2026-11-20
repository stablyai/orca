import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { buildKnownOrcaWorkspaceLayouts } from '../../../../shared/worktree/visibility/ownership'
import { isPathAbsentError } from '../../../filesystem/local-file-io/filesystem-path-containment'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { listWorkspaceCleanupOwnedRepos } from '../workspace-cleanup-run-evidence'

// Folders are compared by filesystem identity, so symlinks, case and Unicode spellings are the OS's call.
type Identity = string

/** Like identityOf, but an error other than absence is `undefined`: protection can't be derived from it. */
async function provenIdentityOf(path: string): Promise<Identity | null | undefined> {
  return stat(path, { bigint: true }).then(
    (stats) => (stats.isDirectory() && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : null),
    (error: unknown) => (isPathAbsentError(error) ? null : undefined)
  )
}

async function identityOf(path: string): Promise<Identity | null> {
  // Bigint: NTFS file ids exceed 2^53 and would round together; inode 0 means no identity.
  return stat(path, { bigint: true }).then(
    (stats) => (stats.isDirectory() && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : null),
    () => null
  )
}

/** Whether the path exists: a permission or I/O error is `unknown`, never absence. */
async function presence(path: string): Promise<'present' | 'missing' | 'unknown'> {
  return lstat(path).then(
    () => 'present' as const,
    (error: unknown) => (isPathAbsentError(error) ? 'missing' : 'unknown')
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
  // Upper then lower folds case pairs one lowercasing misses (final sigma ς and σ are both Σ).
  process.platform === 'linux' ? name : name.normalize('NFC').toUpperCase().toLowerCase()

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
  // A WSL path can't protect a local parent, and touching it can boot a stopped distro.
  return paths.filter((path) => !parseWslUncPath(path))
}

/** Changes whenever what Orca lists, or where it nests workspaces, changes: archive and rename both write rows. */
export function listedCatalogFingerprint(store: RuntimeStore): string {
  const { workspaceDir, nestWorkspaces, workspaceDirHistory } = store.getSettings()
  return JSON.stringify([
    listedPaths(store),
    store.getRepos().map((repo) => [repo.path, repo.worktreeBasePath]),
    workspaceDir,
    nestWorkspaces,
    workspaceDirHistory
  ])
}

export type ListedFolders = {
  /** Existing listed folders, by identity. */
  present: Set<Identity>
  /**
   * Every (existing folder, child name) a listed path passes through. A gone folder holding a
   * listed path stays protected whether that path's own folders exist at the moment or not.
   */
  claims: Set<string>
  /** False when a listed path's symlinks couldn't be followed to the end: then nothing is proven. */
  complete: boolean
  /** Where each listed path that goes through a symlink led, to notice a link retargeted later. */
  links: Map<string, string>
}

const MAX_LINK_HOPS = 8

/**
 * Follows symlinks anywhere along a listed path, dangling ones included, keeping the rest of the
 * path: a listed `/link/nested` whose `/link` points into a gone workspace still protects it.
 */
async function linkTargets(path: string): Promise<{ targets: string[]; complete: boolean }> {
  const targets = [path]
  let current = path
  for (let hop = 0; ; hop += 1) {
    let existing = current
    const rest: string[] = []
    for (
      let state = await presence(existing);
      state !== 'present';
      state = await presence(existing)
    ) {
      const parent = dirname(existing)
      if (state === 'unknown' || parent === existing) {
        return { targets, complete: state !== 'unknown' }
      }
      rest.unshift(basename(existing))
      existing = parent
    }
    const stats = await lstat(existing).catch(() => null)
    if (!stats?.isSymbolicLink()) {
      return { targets, complete: stats !== null }
    }
    const link = hop < MAX_LINK_HOPS ? await readlink(existing).catch(() => null) : null
    // An unreadable link, or one past the hop limit, points somewhere unknown.
    if (link === null) {
      return { targets, complete: false }
    }
    // A relative link resolves from its real folder. Joined unnormalized: `..` after a symlink
    // in the target is the OS's to resolve, not a string operation's.
    const linkFolder = await realpath(dirname(existing)).catch(() => dirname(existing))
    current = [isAbsolute(link) ? link : `${linkFolder}${sep}${link}`, ...rest].join(sep)
    targets.push(current)
  }
}

export async function readListedFolders(store: RuntimeStore): Promise<ListedFolders> {
  const listed: ListedFolders = {
    present: new Set(),
    claims: new Set(),
    complete: true,
    links: new Map()
  }
  const identities = new Map<string, Promise<Identity | null | undefined>>()
  const cachedIdentity = async (path: string): Promise<Identity | null> => {
    let id = identities.get(path)
    if (!id) {
      id = provenIdentityOf(path)
      identities.set(path, id)
    }
    const proven = await id
    // A folder that couldn't be read may hold a listed path's claim: then nothing is proven.
    if (proven === undefined) {
      listed.complete = false
      return null
    }
    return proven
  }
  for (const listedPath of new Set(listedPaths(store))) {
    const { targets, complete } = await linkTargets(listedPath)
    listed.complete &&= complete
    if (targets.length > 1) {
      listed.links.set(listedPath, targets.join('\0'))
    }
    for (const path of targets) {
      const id = await cachedIdentity(path)
      if (id) {
        listed.present.add(id)
      }
      // Byte-exact walk up: each existing ancestor claims the name the path continues with.
      for (
        let child = path, parent = dirname(path);
        parent !== child;
        child = parent, parent = dirname(parent)
      ) {
        const parentId = await cachedIdentity(parent)
        if (parentId) {
          listed.claims.add(`${parentId}/${foldName(basename(child))}`)
        }
      }
    }
  }
  return listed
}

/** Whether the folder or any ancestor is something Orca still lists, such as a flat workspace named like a repo. */
async function isInsideListedFolder(directory: string, listed: ListedFolders): Promise<boolean> {
  // Walk the physical ancestors: a symlinked folder can sit inside a listed checkout elsewhere.
  let current = await realpath(directory).catch(() => null)
  if (current === null) {
    return true
  }
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
    // This host's own path rules: a POSIX repo name can contain `\\`, as worktree creation keeps it.
    const repoName = basename(repo.path).replace(/\.git$/, '')
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

/**
 * Whether the ancestor holds a folder that could be this one under a lossy spelling: transcript
 * parsers trim the recorded cwd, and names can differ only in case or Unicode form.
 */
async function hasLookalikeSibling(folder: GoneFolder): Promise<boolean> {
  const wanted = foldName(folder.name.trim())
  const entries = await readdir(folder.ancestor).catch(() => null)
  return entries === null || entries.some((entry) => foldName(entry.trim()) === wanted)
}

/** Whether the gone folder is gone under every spelling; also re-read right before deletion. */
export async function isStillGone(folder: GoneFolder): Promise<boolean> {
  return (
    (await identityOf(folder.ancestor)) === folder.ancestorId &&
    (await presence(join(folder.ancestor, folder.name))) === 'missing' &&
    !(await hasLookalikeSibling(folder))
  )
}

/** Whether every listed symlink still leads where it did when `listed` was read. */
export async function listedLinksUnchanged(listed: ListedFolders): Promise<boolean> {
  for (const [listedPath, recorded] of listed.links) {
    const { targets, complete } = await linkTargets(listedPath)
    if (!complete || targets.join('\0') !== recorded) {
      return false
    }
  }
  return true
}
