import { realpathSync } from 'node:fs'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { getGitRepoRoot, isGitRepo } from './git/repo'
import { prepareLocalWorktreeRootForRepo } from './worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from './ipc/registered-worktree-roots-cache'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from './providers/ssh-git-dispatch'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from './providers/ssh-filesystem-dispatch'
import { joinRemotePath } from './ssh/ssh-remote-platform'

export type FolderGitPromotionStore = {
  getRepo(id: string): Repo | undefined
  updateRepo(
    id: string,
    updates: Pick<Partial<Repo>, 'kind' | 'externalWorktreeVisibility' | 'projectHostSetupMethod'>
  ): Repo | null
  getAllWorktreeMeta?: () => Record<string, unknown>
  getSettings: () => Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
}

type LocalFolderGitUpgrade = { externalWorktreeVisibility?: 'hide' }

export type RemoteFolderGitProbe =
  | { status: 'upgrade'; updates: LocalFolderGitUpgrade }
  | { status: 'rejected' }
  | { status: 'unverifiable' }

/**
 * A folder project's extra workspaces are `worktreeMeta` rows keyed
 * `repoId::path::workspace:<uuid>`, and only the folder branch of the worktree listing
 * knows those keys exist. Flipping `kind` moves the repo onto the git branch, which lists
 * `git worktree list` (one path) and prunes every lineage id under the repo that is not in
 * it — so those workspaces vanish from the sidebar and their lineage is deleted.
 */
export function folderRepoHasExtraWorkspaces(
  store: Pick<FolderGitPromotionStore, 'getAllWorktreeMeta'>,
  repo: Pick<Repo, 'id' | 'path'>
): boolean {
  const prefix = `${repo.id}::${repo.path}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  const meta = store.getAllWorktreeMeta?.() ?? {}
  return Object.keys(meta).some((key) => key.startsWith(prefix))
}

function resolveRealPath(pathValue: string): string {
  try {
    return realpathSync(pathValue)
  } catch {
    return pathValue
  }
}

/**
 * Git's verdict on the folder, or null when it must stay a folder project.
 *
 * Two comparisons, deliberately at different strictness:
 * - Refuse unless the folder *is* the work-tree root. `.git` existing proves nothing —
 *   git accepts any path inside a work tree, so a stray marker in a subdirectory of
 *   another repo would otherwise flip a project whose path is not a repo root.
 * - Only hide external worktrees when the stored spelling also matches. Add Project
 *   stores the root as `rev-parse --show-toplevel` spells it while a folder project keeps
 *   the path the user picked; when a symlinked parent makes those differ, the root reads
 *   as an *external* worktree, and hiding those would hide the project's only workspace.
 */
export function resolveLocalFolderGitUpgrade(repoPath: string): LocalFolderGitUpgrade | null {
  if (!isGitRepo(repoPath)) {
    return null
  }
  const gitRoot = getGitRepoRoot(repoPath)
  if (resolveRealPath(gitRoot) !== resolveRealPath(repoPath)) {
    return null
  }
  return normalizeRuntimePathForComparison(gitRoot) === normalizeRuntimePathForComparison(repoPath)
    ? { externalWorktreeVisibility: 'hide' }
    : {}
}

function isRemoteContactLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE) ||
    message.includes(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE) ||
    /Reconnect|dropped|unavailable/i.test(message)
  )
}

function isRemoteMissingPathError(error: unknown): boolean {
  if (isRemoteContactLoss(error)) {
    return false
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\bENOENT\b|no such file|not found/i.test(message)
}

/**
 * Remote `.git` probe verdict. A bare `string | 'unverifiable'` union collapses —
 * the literal is subsumed by `string`, so callers get no type help distinguishing
 * "could not look" from a signature. Keep the three outcomes structurally distinct.
 */
export type RemoteGitMarkerSignature =
  | { status: 'present'; signature: string }
  | { status: 'absent' }
  | { status: 'unverifiable' }

export async function readRemoteGitMarkerSignature(
  repo: Pick<Repo, 'path' | 'connectionId'>
): Promise<RemoteGitMarkerSignature> {
  const connectionId = repo.connectionId
  if (!connectionId) {
    return { status: 'unverifiable' }
  }
  const filesystem = getSshFilesystemProvider(connectionId)
  const git = getSshGitProvider(connectionId)
  const host = git?.getHostPlatform()
  if (!filesystem || !git || !host) {
    return { status: 'unverifiable' }
  }
  try {
    const marker = await filesystem.stat(joinRemotePath(host, repo.path, '.git'))
    return {
      status: 'present',
      signature: `${marker.mtimeMs ?? marker.mtime}:${marker.ino ?? 0}:${marker.type}`
    }
  } catch (error) {
    if (isRemoteMissingPathError(error)) {
      return { status: 'absent' }
    }
    return { status: 'unverifiable' }
  }
}

export async function resolveRemoteFolderGitUpgrade(
  repo: Pick<Repo, 'path' | 'connectionId'>
): Promise<RemoteFolderGitProbe> {
  const connectionId = repo.connectionId
  if (!connectionId) {
    return { status: 'unverifiable' }
  }
  const git = getSshGitProvider(connectionId)
  if (!git) {
    return { status: 'unverifiable' }
  }
  let check: { isRepo: boolean; rootPath: string | null }
  try {
    check = await git.isGitRepoAsync(repo.path)
  } catch {
    // Why: a thrown probe is loss of contact or a spawn failure, not a negative
    // git verdict. Treat it as unverifiable so a down host cannot freeze the folder.
    return { status: 'unverifiable' }
  }
  if (!check.isRepo) {
    return { status: 'rejected' }
  }
  if (!check.rootPath) {
    return { status: 'upgrade', updates: {} }
  }
  if (
    normalizeRuntimePathForComparison(check.rootPath) !==
    normalizeRuntimePathForComparison(repo.path)
  ) {
    return { status: 'rejected' }
  }
  return { status: 'upgrade', updates: { externalWorktreeVisibility: 'hide' } }
}

export async function promoteFolderRepoToGit(
  store: FolderGitPromotionStore,
  repoId: string,
  updates: LocalFolderGitUpgrade & Pick<Partial<Repo>, 'projectHostSetupMethod'>
): Promise<Repo | null> {
  const current = store.getRepo(repoId)
  if (!current || !isFolderRepo(current)) {
    return null
  }
  const upgraded = store.updateRepo(repoId, { kind: 'git', ...updates })
  if (!upgraded) {
    return null
  }
  await prepareLocalWorktreeRootForRepo(store, upgraded)
  invalidateAuthorizedRootsCache()
  return upgraded
}

export async function tryPromoteLocalFolderRepoToGit(
  store: FolderGitPromotionStore,
  repo: Repo,
  extraUpdates: Pick<Partial<Repo>, 'projectHostSetupMethod'> = {}
): Promise<Repo | null> {
  if (!isFolderRepo(repo) || folderRepoHasExtraWorkspaces(store, repo)) {
    return null
  }
  const updates = resolveLocalFolderGitUpgrade(repo.path)
  if (!updates) {
    return null
  }
  return promoteFolderRepoToGit(store, repo.id, { ...updates, ...extraUpdates })
}

export async function tryPromoteRemoteFolderRepoToGit(
  store: FolderGitPromotionStore,
  repo: Repo,
  extraUpdates: Pick<Partial<Repo>, 'projectHostSetupMethod'> = {}
): Promise<Repo | null> {
  if (!isFolderRepo(repo) || folderRepoHasExtraWorkspaces(store, repo)) {
    return null
  }
  const probe = await resolveRemoteFolderGitUpgrade(repo)
  if (probe.status !== 'upgrade') {
    return null
  }
  return promoteFolderRepoToGit(store, repo.id, { ...probe.updates, ...extraUpdates })
}
