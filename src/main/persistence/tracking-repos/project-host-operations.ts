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
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../shared/execution-host'
import { normalizeProjectRuntimePreference } from '../../../shared/project-execution-runtime'
import { findProjectHostSetup } from '../../../shared/project-host-setup-target'
import { makeProjectHostSetupId } from './project-host-compatibility'
import { repoGitUsernameCacheKey } from './repo-hydration'

export type ProjectHostMutationOperations = {
  state: PersistedState
  gitUsernameCache: Map<string, string>
  bumpLocalWorktreeScanGeneration: (repoId: string) => void
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
  removeProjectForHost: (target: RepoHostTarget) => void
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

  private removeProjectForHost(target: RepoHostTarget): void {
    this.operations.removeProjectForHost(target)
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

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
      for (const repoId of project.sourceRepoIds) {
        this.operations.bumpLocalWorktreeScanGeneration(repoId)
      }
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
    // Independent setup persistence survives future repo projection sync.
    this.state.projectHostSetups.push(setup)
    this.scheduleSave()
    return { project, setup }
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult | null {
    const setup = findProjectHostSetup(this.state.projectHostSetups, args)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    const repo = this.findSetupRepo(setup)
    if (setup.repoId && !repo) {
      // A stale repo-backed setup; editing it would write a sibling host's row.
      return null
    }
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

  // Same-ID repos require host proof; sibling-host fallback would edit the wrong row.
  private findSetupRepo(setup: ProjectHostSetup): Repo | undefined {
    return setup.repoId
      ? this.state.repos.find(
          (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
        )
      : undefined
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult | null {
    const setup = findProjectHostSetup(this.state.projectHostSetups, args)
    if (!setup) {
      return null
    }
    const project = this.state.projects.find((entry) => entry.id === setup.projectId)
    if (!project) {
      return null
    }
    const repo = this.findSetupRepo(setup)
    if (repo) {
      this.removeProjectForHost(repo)
      return { project, setup, repo: this.hydrateRepo(repo) }
    }
    this.state.projectHostSetups = this.state.projectHostSetups.filter((entry) => entry !== setup)
    this.scheduleSave()
    return { project, setup }
  }

  getRepoCount(): number {
    return this.state.repos.length
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    return repo ? this.hydrateRepo(repo) : undefined
  }

  /** Store probed usernames by exact repo/host; renderer patches cannot author this cache. Returns whether hydration changed. */
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
      // Retain branch-prefix identity for startup before background enrichment reruns.
      repo.gitUsername = username
    } else {
      delete repo.gitUsername
    }
    this.scheduleSave()
    return true
  }
}
