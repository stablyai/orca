import type { Store } from './persistence'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../shared/folder-workspace-execution-host'
import {
  getWorkspaceRuntimePreference,
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../shared/project-execution-runtime'
import {
  getCachedWslAvailability,
  getCachedWslDistros,
  hasCachedWslAvailability,
  hasCachedWslDistros
} from './wsl'
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import { projectMatchesRepo } from '../shared/project-repo-match'
import {
  resolveLocalWindowsTerminalRuntimeOptions,
  type LocalWindowsTerminalRuntimeOptions
} from '../shared/local-windows-terminal-runtime'
import { resolveManagedSshHostLoginShell } from './pty/managed-ssh-host-login-shell'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'

// Structural typing lets narrowed runtime stores use the same resolution as workspace creation.
export type ProjectRuntimeResolutionStore = {
  getProjects?: Store['getProjects']
  getRepo?: Store['getRepo']
  getSettings?: () => Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
}

type ResolvableStore = ProjectRuntimeResolutionStore & {
  getProjects: NonNullable<ProjectRuntimeResolutionStore['getProjects']>
  getSettings: NonNullable<ProjectRuntimeResolutionStore['getSettings']>
}

function canResolveProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore {
  return typeof store.getProjects === 'function' && typeof store.getSettings === 'function'
}

function canResolveProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore & { getRepo: NonNullable<ProjectRuntimeResolutionStore['getRepo']> } {
  return canResolveProjectRuntimeForRepo(store) && typeof store.getRepo === 'function'
}

function resolveLocalProjectRuntime(
  store: ResolvableStore,
  project: Pick<Project, 'id' | 'localWindowsRuntimePreference'>,
  settings: ReturnType<ResolvableStore['getSettings']> = store.getSettings(),
  checkWslCache = true
): ProjectExecutionRuntimeResolution {
  const wslAvailable =
    checkWslCache && hasCachedWslAvailability()
      ? (getCachedWslAvailability() ?? undefined)
      : undefined
  const availableWslDistros = checkWslCache && hasCachedWslDistros() ? getCachedWslDistros() : null
  return resolveProjectExecutionRuntime({
    appPlatform: process.platform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault,
    wslAvailable,
    availableWslDistros
  })
}

/** One local project's runtime, from the current WSL discovery caches. */
export function resolveLocalProjectRuntimeForProject(
  store: ProjectRuntimeResolutionStore,
  project: Pick<Project, 'id' | 'localWindowsRuntimePreference'>
): ProjectExecutionRuntimeResolution | undefined {
  return canResolveProjectRuntimeForRepo(store)
    ? resolveLocalProjectRuntime(store, project)
    : undefined
}

export function resolveLocalProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): ProjectExecutionRuntimeResolution | undefined {
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    !canResolveProjectRuntimeForRepo(store)
  ) {
    return undefined
  }
  const project = store.getProjects().find((entry) => entry.sourceRepoIds.includes(repo.id))
  if (!project) {
    return undefined
  }
  return resolveLocalProjectRuntime(store, project)
}

/** Match renderer precedence: project preference, WSL-share distro, then global default. */
export function resolveLocalWorkspaceRuntime(
  store: ProjectRuntimeResolutionStore,
  repo: Repo,
  workspacePath: string | null | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    !canResolveProjectRuntimeForRepo(store)
  ) {
    return undefined
  }
  const project = store.getProjects().find((entry) => projectMatchesRepo(entry, repo.id))
  const preference = getWorkspaceRuntimePreference(
    project?.localWindowsRuntimePreference,
    workspacePath
  )
  // WSL-share paths supply their distro; ignore potentially stale discovery caches for inferred preferences.
  return resolveLocalProjectRuntime(
    store,
    { id: project?.id ?? repo.id, localWindowsRuntimePreference: preference },
    undefined,
    Boolean(project?.localWindowsRuntimePreference) || preference.kind !== 'wsl'
  )
}

/** A folder inherits a runtime only from a single repo on the local host. */
export function findLocalFolderWorkspaceRuntimeRepo(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string
): Repo | undefined {
  const folder = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!folder || resolveFolderWorkspaceHost(state, folder.id).kind !== 'local') {
    return undefined
  }
  const group = state.projectGroups.find((entry) => entry.id === folder.projectGroupId)
  if (
    (folder.executionHostId ?? group?.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !==
    LOCAL_EXECUTION_HOST_ID
  ) {
    return undefined
  }
  const candidates = findFolderWorkspaceCandidateRepos(state, folder.id)
  const repo = candidates.length === 1 ? candidates[0] : undefined
  return repo && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID ? repo : undefined
}

export type LaunchScopeRuntimeStore = ProjectRuntimeResolutionStore & {
  getRepos?: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjectGroups?: () => ProjectGroup[]
}

/** Remote scopes resolve their runtime on their own host. */
export function resolveLocalLaunchScopeRuntime(
  store: LaunchScopeRuntimeStore,
  scope: {
    id: string
    path: string
    connectionId: string | null
    repo: Repo | null
    folderWorkspace: Pick<FolderWorkspace, 'id'> | null
  }
): ProjectExecutionRuntimeResolution | undefined {
  if (scope.connectionId) {
    return undefined
  }
  const repo =
    scope.repo ??
    (scope.folderWorkspace
      ? findLocalFolderWorkspaceRuntimeRepo(
          {
            folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
            projectGroups: store.getProjectGroups?.() ?? [],
            repos: store.getRepos?.() ?? []
          },
          scope.folderWorkspace.id
        )
      : undefined)
  // A repo-less folder has no runtime: its path alone places it, and its cwd picks its shell.
  return repo ? resolveLocalWorkspaceRuntime(store, repo, scope.path) : undefined
}

export function resolveLocalProjectRuntimesForRepos(
  store: ProjectRuntimeResolutionStore,
  repos: readonly Repo[]
): ReadonlyMap<string, ProjectExecutionRuntimeResolution> {
  const runtimeByRepoId = new Map<string, ProjectExecutionRuntimeResolution>()
  if (!canResolveProjectRuntimeForRepo(store)) {
    return runtimeByRepoId
  }
  const requestedRepoIds = new Set(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.id)
  )
  if (requestedRepoIds.size === 0) {
    return runtimeByRepoId
  }
  const settings = store.getSettings()
  for (const project of store.getProjects()) {
    const matchingRepoIds = project.sourceRepoIds.filter(
      (repoId) => requestedRepoIds.has(repoId) && !runtimeByRepoId.has(repoId)
    )
    if (matchingRepoIds.length === 0) {
      continue
    }
    // Resolve once per project to avoid repeated settings scans during mobile polls.
    const runtime = resolveLocalProjectRuntime(store, project, settings)
    for (const repoId of matchingRepoIds) {
      runtimeByRepoId.set(repoId, runtime)
    }
  }
  return runtimeByRepoId
}

export function resolveLocalProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore | undefined,
  worktreeId: string | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (!store || !worktreeId) {
    return undefined
  }
  if (!canResolveProjectRuntimeForWorktreeId(store)) {
    return undefined
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
  return repo ? resolveLocalProjectRuntimeForRepo(store, repo) : undefined
}

type LocalPtySettings = Partial<
  Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsWslDistro' | 'terminalDefaultShell'>
>

/** Throws for a Windows runtime that needs repair. */
export function resolveLocalPtyOptions(
  settings: LocalPtySettings | undefined,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  requestedShellOverride: string | undefined,
  /** Replaces a `wsl.exe` setting on a Windows-host runtime; absent is `powershell.exe`. */
  fallbackHostShell?: string
): LocalWindowsTerminalRuntimeOptions {
  return process.platform === 'win32'
    ? resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride,
        settings,
        projectRuntime,
        fallbackHostShell,
        sshLoginShell: resolveManagedSshHostLoginShell()
      })
    : {
        shellOverride: requestedShellOverride ?? (settings?.terminalDefaultShell || undefined),
        terminalWindowsWslDistro: null
      }
}

/** Plain terminals use the project runtime and fall back to COMSPEC for the Windows host shell. */
export function resolvePlainTerminalPtyOptions(
  store: ProjectRuntimeResolutionStore | undefined,
  settings: LocalPtySettings | undefined,
  worktreeId: string | undefined,
  requestedShellOverride: string | undefined
): LocalWindowsTerminalRuntimeOptions {
  return resolveLocalPtyOptions(
    settings,
    resolveLocalProjectRuntimeForWorktreeId(store, worktreeId),
    requestedShellOverride,
    process.env.COMSPEC || 'powershell.exe'
  )
}
