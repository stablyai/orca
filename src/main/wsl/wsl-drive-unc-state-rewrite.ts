/**
 * The profile state of UNC Windows-drive projects converted to their drive paths (D1c): each field
 * that can name one is re-keyed by wsl-drive-unc-identity-rewrite.ts, and the projects switch to
 * Git for Windows with their terminals still in the distro. Pure; the caller writes the result.
 */
import { composeWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { LocalWindowsRuntimePreference } from '../../shared/project-execution-runtime'
import type { Project } from '../../shared/project-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  getRepoMainWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree/id'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { WSL_DRIVE_UNC_STATE_DISPOSITIONS } from '../../shared/wsl-drive-unc-state-dispositions'
import { wslMoveRepoPaths } from '../persistence/moving-wsl-projects/wsl-move-scope'
import { withoutDiscoveryShadows } from './wsl-drive-unc-discovery-shadows'
import { wslUncDrivePathToWindows } from './wsl-drive-unc-project-scope'
import {
  createWslDriveUncRewriter,
  rewriteWslDriveUncValue,
  type WslDriveUncRewriter
} from './wsl-drive-unc-identity-rewrite'

export type WslDriveUncStateScope = {
  distro: string
  repoIds: readonly string[]
  folderWorkspaceIds: readonly string[]
}

export type WslDriveUncStateRewrite = {
  state: PersistedState
  /** Each converted worktree id, old to new, for the stores outside the profile. */
  worktreeIds: Map<string, string>
}

/** Unchanged fields keep their reference, so only the domains that changed are written. */
export function rewriteWslDriveUncState(
  saved: PersistedState,
  scope: WslDriveUncStateScope
): WslDriveUncStateRewrite {
  const repoIds = new Set(scope.repoIds)
  const folderWorkspaceIds = new Set(scope.folderWorkspaceIds)
  const { roots, worktreeIds } = collectRewriteRoots(saved, scope)
  const state = withoutDiscoveryShadows(saved, worktreeIds)
  const rewriter = createWslDriveUncRewriter({
    distro: scope.distro,
    repoIds,
    folderWorkspaceIds,
    roots
  })
  const next: PersistedState = { ...state }
  for (const [field, disposition] of Object.entries(WSL_DRIVE_UNC_STATE_DISPOSITIONS)) {
    if (disposition === 'rewrite' && isStateField(field) && state[field] !== undefined) {
      Object.assign(next, { [field]: rewriteWslDriveUncValue(state[field], rewriter) })
    }
  }
  next.projects = sameIfUnchanged(
    next.projects,
    withWindowsGit(next.projects, repoIds, scope.distro)
  )
  next.projectGroups = sameIfUnchanged(
    next.projectGroups,
    withConvertedGroupFolders(next, repoIds, folderWorkspaceIds, scope.distro)
  )
  next.worktreeMeta = withPriorIds(next.worktreeMeta, worktreeIds, (id) => [id])
  if (next.worktreeMetaByIdentity) {
    next.worktreeMetaByIdentity = withPriorIds(
      next.worktreeMetaByIdentity,
      worktreeIds,
      (id) =>
        next.worktreeIdentityAliases?.[composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, id)] ??
        []
    )
  }
  return { state: next, worktreeIds }
}

/** Keeps the original array when no row changed, so an unchanged field is not written. */
function sameIfUnchanged<T>(before: T[], after: T[]): T[] {
  return after.every((row, index) => row === before[index]) ? before : after
}

function isStateField(field: string): field is keyof PersistedState {
  return Object.hasOwn(WSL_DRIVE_UNC_STATE_DISPOSITIONS, field)
}

/** Every converted worktree id the rewritten fields name, old to new. */
/** The folders whose bare paths a conversion of this scope rewrites. */
export function wslDriveUncRewriteRoots(
  saved: PersistedState,
  scope: WslDriveUncStateScope
): string[] {
  return collectRewriteRoots(saved, scope).roots
}

function collectRewriteRoots(
  saved: PersistedState,
  scope: WslDriveUncStateScope
): { roots: string[]; worktreeIds: Map<string, string> } {
  const repoIds = new Set(scope.repoIds)
  const folderWorkspaceIds = new Set(scope.folderWorkspaceIds)
  const roots = [
    ...saved.repos.filter((repo) => repoIds.has(repo.id)).flatMap(wslMoveRepoPaths),
    ...saved.folderWorkspaces
      .filter((folder) => folderWorkspaceIds.has(folder.id))
      .map((folder) => folder.folderPath)
  ]
  const ids = createWslDriveUncRewriter({
    distro: scope.distro,
    repoIds,
    folderWorkspaceIds,
    roots
  })
  const worktreeIds = collectRewrittenWorktreeIds(saved, ids)
  // A worktree outside the repo's own folders is still the project's.
  return { roots: [...roots, ...[...worktreeIds.keys()].flatMap(worktreePathOf)], worktreeIds }
}

function collectRewrittenWorktreeIds(
  state: PersistedState,
  rewriter: WslDriveUncRewriter
): Map<string, string> {
  const ids = new Map<string, string>()
  const recorder: WslDriveUncRewriter = {
    identity: (value) => {
      const mapped = rewriter.identity(value)
      const id = bareWorktreeId(value)
      if (mapped !== value && id) {
        ids.set(id, rewriter.identity(id))
      }
      return value
    }
  }
  for (const [field, disposition] of Object.entries(WSL_DRIVE_UNC_STATE_DISPOSITIONS)) {
    if (disposition === 'rewrite' && isStateField(field)) {
      rewriteWslDriveUncValue(state[field], recorder)
    }
  }
  for (const repo of state.repos) {
    recorder.identity(getRepoMainWorktreeId(repo))
  }
  return ids
}

/** The worktree id inside an owner key or a host-qualified one; null for any other string. */
function bareWorktreeId(value: string): string | null {
  const local = `${LOCAL_EXECUTION_HOST_ID}|`
  const unqualified = value.startsWith(local) ? value.slice(local.length) : value
  const key = parseWorkspaceKey(unqualified)
  const id = key?.type === 'worktree' ? key.worktreeId : key ? null : unqualified
  return id &&
    splitWorktreeId(id) &&
    !id.includes(PTY_SESSION_ID_SEPARATOR) &&
    !id.startsWith('editor:')
    ? id
    : null
}

function worktreePathOf(worktreeId: string): string[] {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed ? [parsed.worktreePath] : []
}

/**
 * The projects of the converted repos run Orca's Git on Windows. Terminals stay where they ran:
 * a project inferred its distro from the UNC path, which the drive path no longer carries.
 */
function withWindowsGit(
  projects: Project[],
  repoIds: ReadonlySet<string>,
  distro: string
): Project[] {
  return projects.map((project) => {
    if (!project.sourceRepoIds.some((id) => repoIds.has(id))) {
      return project
    }
    if (!project.sourceRepoIds.every((id) => repoIds.has(id))) {
      throw new Error('wsl_drive_unc_project_split')
    }
    const preference = windowsGitPreference(project.localWindowsRuntimePreference, distro)
    return preference ? { ...project, localWindowsRuntimePreference: preference } : project
  })
}

function windowsGitPreference(
  current: LocalWindowsRuntimePreference | undefined,
  distro: string
): LocalWindowsRuntimePreference | null {
  if (current?.kind === 'windows-host') {
    // Windows shells already; Orca's Git runs on Windows with them.
    return null
  }
  if (current?.kind === 'wsl') {
    return current.git === 'windows-host' ? null : { ...current, git: 'windows-host' }
  }
  return { kind: 'wsl', distro, git: 'windows-host' }
}

/** A group whose projects all convert was made from their parent folder, which converts too. */
function withConvertedGroupFolders(
  state: PersistedState,
  repoIds: ReadonlySet<string>,
  folderWorkspaceIds: ReadonlySet<string>,
  distro: string
): PersistedState['projectGroups'] {
  return state.projectGroups.map((group) => {
    const members = [
      ...state.repos
        .filter((repo) => repo.projectGroupId === group.id)
        .map((repo) => repoIds.has(repo.id)),
      ...state.folderWorkspaces
        .filter((folder) => folder.projectGroupId === group.id)
        .map((folder) => folderWorkspaceIds.has(folder.id))
    ]
    const parentPath = group.parentPath && wslUncDrivePathToWindows(group.parentPath, distro)
    return parentPath && members.length > 0 && members.every(Boolean)
      ? { ...group, parentPath }
      : group
  })
}

/** Appends each row's old id to `priorWorktreeIds`, so readers still holding it find the row. */
function withPriorIds(
  rows: Record<string, WorktreeMeta>,
  worktreeIds: ReadonlyMap<string, string>,
  keysOf: (newWorktreeId: string) => readonly string[]
): Record<string, WorktreeMeta> {
  let next = rows
  for (const [oldId, newId] of worktreeIds) {
    for (const key of keysOf(newId)) {
      const row = next[key]
      if (!row || row.priorWorktreeIds?.includes(oldId)) {
        continue
      }
      next = next === rows ? { ...rows } : next
      next[key] = { ...row, priorWorktreeIds: [...(row.priorWorktreeIds ?? []), oldId] }
    }
  }
  return next
}
