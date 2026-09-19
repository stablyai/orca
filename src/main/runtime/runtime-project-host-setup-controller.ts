import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import {
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getProjectIdForProviderIdentity } from '../../shared/project-host-setup-projection'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeProjectHostSetupDependencies = {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
  addRepo: (path: string, kind: 'folder' | 'git', hostId: ExecutionHostId) => Promise<Repo>
  /** Register an existing path that lives on an SSH host; `addRepo` only reaches local/runtime hosts. */
  addRemoteRepo: (args: {
    connectionId: string
    remotePath: string
    displayName?: string
    kind: 'folder' | 'git'
  }) => Promise<Repo>
  cloneRepo: (url: string, destination: string, hostId: ExecutionHostId) => Promise<Repo>
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

// Why clone alone still refuses: nothing in this process clones onto an SSH host. `cloneRepo` runs
// `git clone` on the client, so accepting `ssh:*` here would register the client's copy as the
// host's repo — a local answer to a remote question. Registering an existing remote path, by
// contrast, has a correct implementation this process already uses over IPC.
function assertCloneHostIsSupported(hostId: ExecutionHostId | null | undefined): void {
  if (parseExecutionHostId(hostId)?.kind !== 'ssh') {
    return
  }
  throw new Error(
    'Cloning onto an SSH host is not supported. Clone the repository on the host, then set the project up from that existing folder.'
  )
}

export class RuntimeProjectHostSetupController {
  constructor(private readonly deps: RuntimeProjectHostSetupDependencies) {}

  listProjects(): Project[] {
    return this.deps.getStore()?.getProjects?.() ?? []
  }

  updateProject(projectId: string, updates: ProjectUpdateArgs['updates']): Project {
    const store = this.deps.getStore()
    if (!store?.updateProject) {
      throw new Error('runtime_unavailable')
    }
    const project = store.updateProject(projectId, updates)
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }
    this.deps.invalidateResolvedWorktrees()
    this.deps.notifyReposChanged()
    return project
  }

  listSetups(): ProjectHostSetup[] {
    return this.deps.getStore()?.getProjectHostSetups?.() ?? []
  }

  createSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult {
    const store = this.deps.getStore()
    if (!store?.createProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    const result = store.createProjectHostSetup(args)
    if (!result) {
      throw new Error(`Project not found: ${args.projectId}`)
    }
    return result
  }

  async setupExistingFolder(
    args: ProjectHostSetupExistingFolderArgs
  ): Promise<ProjectHostSetupResult> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const kind = args.kind === 'folder' ? 'folder' : 'git'
    const knownRepoIds = new Set(this.deps.listRepos().map((repo) => repo.id))
    // Why route rather than refuse: this process owns the SSH connection, and its own IPC handler
    // already registers `ssh:*` hosts correctly. Refusing here only made the CLI and runtime RPC
    // disagree with the desktop app about what the same process can do.
    const sshTargetId = getSshTargetIdForExecutionHost(args.hostId)
    const repo = sshTargetId
      ? await this.deps.addRemoteRepo({
          connectionId: sshTargetId,
          remotePath: args.path,
          ...(args.displayName ? { displayName: args.displayName } : {}),
          kind
        })
      : await this.deps.addRepo(args.path, kind, args.hostId)
    return this.completeSetup(args, repo, !knownRepoIds.has(repo.id))
  }

  async setupClone(args: ProjectHostSetupCloneArgs): Promise<ProjectHostSetupResult> {
    assertCloneHostIsSupported(args.hostId)
    const knownRepoIds = new Set(this.deps.listRepos().map((repo) => repo.id))
    const repo = await this.deps.cloneRepo(args.url, args.destination, args.hostId)
    return this.completeSetup(
      { ...args, path: repo.path, kind: 'git', setupMethod: 'cloned' },
      repo,
      !knownRepoIds.has(repo.id)
    )
  }

  updateSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult {
    const store = this.deps.getStore()
    if (!store?.updateProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    const result = store.updateProjectHostSetup(args)
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`)
    }
    if ('worktreeBasePath' in args.updates && result.repo) {
      void prepareLocalWorktreeRootForRepo(store, result.repo)
      invalidateAuthorizedRootsCache()
    }
    return result
  }

  deleteSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult {
    const store = this.deps.getStore()
    if (!store?.deleteProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    const result = store.deleteProjectHostSetup(args)
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`)
    }
    return result
  }

  private completeSetup(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
    repoWasCreated: boolean
  ): ProjectHostSetupResult {
    try {
      return this.linkRepo(args, initialRepo)
    } catch (error) {
      if (repoWasCreated) {
        this.deps.getStore()?.removeProject?.(initialRepo.id)
        this.deps.invalidateResolvedWorktrees()
        this.deps.invalidateWorktreeScan(initialRepo.id)
        invalidateAuthorizedRootsCache()
        this.deps.notifyReposChanged()
      }
      throw error
    }
  }

  private linkRepo(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo
  ): ProjectHostSetupResult {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    let repo = initialRepo
    let setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    if (setup.projectId !== args.projectId) {
      const existingProject = this.listProjects().find((project) => project.id === args.projectId)
      const identity = existingProject?.providerIdentity ?? args.projectProviderIdentity
      if (!identity || getProjectIdForProviderIdentity(identity) !== args.projectId) {
        throw new Error('Imported folder does not match the selected project identity.')
      }
      const updated = store.updateRepo(repo.id, {
        upstream: {
          owner: identity.owner,
          repo: identity.repo,
          ...(identity.host ? { host: identity.host } : {})
        }
      })
      if (!updated) {
        throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
      }
      repo = updated
      setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    }
    const setupMethod = args.setupMethod ?? 'imported-existing-folder'
    const updated = store.updateRepo(repo.id, { projectHostSetupMethod: setupMethod })
    if (!updated) {
      throw new Error(
        `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`
      )
    }
    repo = updated
    setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    const project = this.listProjects().find((entry) => entry.id === setup.projectId)
    if (!project) {
      throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
    }
    return { project, setup, repo }
  }
}
