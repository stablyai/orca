import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../../shared/project-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../shared/execution-host'
import { normalizeProjectRuntimePreference } from '../../../shared/project-execution-runtime'
import { makeProjectHostSetupId } from './project-host-compatibility'
import { repoGitUsernameCacheKey } from './repo-hydration'

export type ProjectHostMutationOperations = {
  state: PersistedState
  gitUsernameCache: Map<string, string>
  hydrateRepo: (repo: Repo) => Repo
  updateRepoBackedProjectHostSetup: (
    setup: ProjectHostSetup,
    repo: Repo,
    updates: ProjectHostSetupUpdateArgs['updates']
  ) => { setup: ProjectHostSetup; repo: Repo } | null
  updateIndependentProjectHostSetup: (
    setup: ProjectHostSetup,
    updates: ProjectHostSetupUpdateArgs['updates']
  ) => ProjectHostSetup
  removeProjectForHost: (id: string, hostId: ProjectHostSetup['hostId']) => void
  scheduleSave: () => void
}

export class ProjectHostPersistenceOperations {
  constructor(private readonly operations: ProjectHostMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private get gitUsernameCache(): Map<string, string> {
    return this.operations.gitUsernameCache
  }

  private hydrateRepo(repo: Repo): Repo {
    return this.operations.hydrateRepo(repo)
  }

  private updateRepoBackedProjectHostSetup(
    setup: ProjectHostSetup,
    repo: Repo,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): { setup: ProjectHostSetup; repo: Repo } | null {
    return this.operations.updateRepoBackedProjectHostSetup(setup, repo, updates)
  }

  private updateIndependentProjectHostSetup(
    setup: ProjectHostSetup,
    updates: ProjectHostSetupUpdateArgs['updates']
  ): ProjectHostSetup {
    return this.operations.updateIndependentProjectHostSetup(setup, updates)
  }

  private removeProjectForHost(id: string, hostId: ProjectHostSetup['hostId']): void {
    this.operations.removeProjectForHost(id, hostId)
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getRepos(): Repo[] {
    return this.state.repos.map((repo) => this.hydrateRepo(repo))
  }

  getProjects(): Project[] {
    return [...this.state.projects]
  }

  updateProject(id: string, updates: ProjectUpdateArgs['updates']): Project | null {
    const project = this.state.projects.find((entry) => entry.id === id)
    if (!project) {
      return null
    }
    if ('localWindowsRuntimePreference' in updates) {
      if (updates.localWindowsRuntimePreference === undefined) {
        delete project.localWindowsRuntimePreference
      } else {
        project.localWindowsRuntimePreference = normalizeProjectRuntimePreference(
          updates.localWindowsRuntimePreference
        )
      }
    }
    project.updatedAt = Date.now()
    this.scheduleSave()
    return { ...project }
  }

  getProjectHostSetups(): ProjectHostSetup[] {
    return [...this.state.projectHostSetups]
  }

  createProjectHostSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult | null {
    const project = this.state.projects.find((entry) => entry.id === args.projectId)
    if (!project) {
      return null
    }
    const hostId = normalizeExecutionHostId(args.hostId)
    if (!hostId) {
      throw new Error(`Invalid host ID: ${args.hostId}`)
    }
    const duplicateSetup = this.state.projectHostSetups.find(
      (entry) => entry.projectId === project.id && entry.hostId === hostId
    )
    if (duplicateSetup) {
      throw new Error(`Project host setup already exists: ${duplicateSetup.id}`)
    }
    const now = Date.now()
    const existingIds = new Set(this.state.projectHostSetups.map((entry) => entry.id))
    const setup: ProjectHostSetup = {
      id: makeProjectHostSetupId(project.id, hostId, existingIds, args.setupId),
      projectId: project.id,
      hostId,
      repoId: '',
      path: args.path?.trim() ?? '',
      displayName: args.displayName?.trim() || project.displayName,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.worktreeBasePath?.trim() ? { worktreeBasePath: args.worktreeBasePath.trim() } : {}),
      ...(args.gitUsername?.trim() ? { gitUsername: args.gitUsername.trim() } : {}),
      setupState: args.setupState ?? 'not-set-up',
      setupMethod: args.setupMethod ?? 'provisioned',
      createdAt: now,
      updatedAt: now
    }
    // Why: persist independently so future repo projection sync doesn't erase this non-repo-backed setup.
    this.state.projectHostSetups.push(setup)
    this.scheduleSave()
    return { project, setup }
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult | null {
    const setup = this.state.projectHostSetups.find((entry) => entry.id === args.setupId)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    const repo = setup.repoId
      ? this.state.repos.find((entry) => entry.id === setup.repoId)
      : undefined
    if (repo) {
      const updated = this.updateRepoBackedProjectHostSetup(setup, repo, args.updates)
      const updatedProject = updated
        ? this.state.projects.find((entry) => entry.id === updated.setup.projectId)
        : undefined
      return updated && updatedProject
        ? { project: updatedProject, setup: updated.setup, repo: updated.repo }
        : null
    }
    const updatedSetup = this.updateIndependentProjectHostSetup(setup, args.updates)
    return { project, setup: updatedSetup }
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult | null {
    const setup = this.state.projectHostSetups.find((entry) => entry.id === args.setupId)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    // Why: the same repo id can exist on multiple execution hosts, so match this setup's own host
    // row and never fall back to a sibling host's row — a stale repoId/hostId would delete that host's
    // registration. With no exact match the setup is stale, and the path below drops just the setup.
    const repo = setup.repoId
      ? this.state.repos.find(
          (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
        )
      : undefined
    if (repo) {
      this.removeProjectForHost(repo.id, setup.hostId)
      return { project, setup, repo: this.hydrateRepo(repo) }
    }
    this.state.projectHostSetups = this.state.projectHostSetups.filter(
      (entry) => entry.id !== setup.id
    )
    this.scheduleSave()
    return { project, setup }
  }

  /** O(1) repo count; unlike `getRepos()` this skips per-repo hydration. */
  getRepoCount(): number {
    return this.state.repos.length
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    return repo ? this.hydrateRepo(repo) : undefined
  }

  /**
   * Record a background-resolved git username; kept out of updateRepo's whitelist so the renderer can't write it directly.
   * Takes the probed repo, not just its id: the same id can exist on several execution hosts, and an
   * id-only lookup would write one host's username onto a sibling host's row and cache key.
   * @returns true when the hydrated value changed.
   */
  setResolvedRepoGitUsername(
    target: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    username: string
  ): boolean {
    const targetHostId = getRepoExecutionHostId(target)
    const repo = this.state.repos.find(
      (r) => r.id === target.id && getRepoExecutionHostId(r) === targetHostId
    )
    if (!repo) {
      return false
    }
    const cacheKey = repoGitUsernameCacheKey(repo)
    const previous = this.gitUsernameCache.get(cacheKey) ?? repo.gitUsername ?? ''
    this.gitUsernameCache.set(cacheKey, username)
    if (previous === username) {
      return false
    }
    if (username) {
      // Why: persist so the next launch hydrates repos with the right branch prefix before enrichment re-runs.
      repo.gitUsername = username
    } else {
      delete repo.gitUsername
    }
    this.scheduleSave()
    return true
  }
}
