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
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { resolveImportedFolderProjectLink } from '../../shared/imported-folder-project-identity'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import {
  SshHostNotServedError,
  sshTargetNotConnectedMessage
} from '../providers/ssh-host-not-served-error'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { updateProjectHostSetupWithProvenKind } from '../folder-repo-git-conversion'
import type { RuntimeStore } from './runtime-store-contract'
import { readAllWorktreeMetaForRepo } from '../persistence/host-qualified-worktree-meta'
import { readCurrentGitRemoteIdentity } from '../repo-git-remote-identity'
import {
  countRepoWorkspacesWithMetadata,
  describeProjectRemovalRefusal
} from './project-removal-impact'
import {
  assertWslMoveHostSetupIdWritable,
  assertWslMoveHostSetupWritable,
  assertWslMoveReposWritable
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { runtimeVisibleProjectHostSetups } from './runtime-visible-catalog'
import {
  findProjectHostSetup,
  type ProjectHostSetupTarget
} from '../../shared/project-host-setup-target'

type RuntimeProjectHostSetupDependencies = {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
  addRepo: (path: string, kind: 'folder' | 'git', hostId: ExecutionHostId) => Promise<Repo>
  cloneRepo: (url: string, destination: string, hostId: ExecutionHostId) => Promise<Repo>
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
  countLiveTerminalsForRepo: (repo: Repo) => number
}

// cloneRepo runs locally; accepting SSH would register the client's checkout as a remote repo.
function assertCloneHostIsSupported(hostId: ExecutionHostId | null | undefined): void {
  if (parseExecutionHostId(hostId)?.kind !== 'ssh') {
    return
  }
  throw new Error(
    'Cloning onto an SSH host is not supported. Clone the repository on the host, then set the project up from that existing folder.'
  )
}

export const SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE =
  "This Orca server can't add projects on its SSH hosts. Add the SSH host on your computer to open its projects."

function sshTargetNotServedError(connectionId: string): SshHostNotServedError {
  return new SshHostNotServedError(connectionId, sshTargetNotConnectedMessage(connectionId))
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
    const existing = store.getProjects?.().find((entry) => entry.id === projectId)
    assertWslMoveReposWritable(store, existing?.sourceRepoIds ?? [])
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

  /** What clients may list; internal lookups keep the full store, as `listSetups` does. */
  listVisibleSetups(): ProjectHostSetup[] {
    return runtimeVisibleProjectHostSetups(this.deps.getStore())
  }

  createSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult {
    const store = this.deps.getStore()
    if (!store?.createProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    assertWslMoveHostSetupWritable(store, args)
    const result = store.createProjectHostSetup(args)
    if (!result) {
      throw new Error(`Project not found: ${args.projectId}`)
    }
    this.deps.notifyReposChanged()
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
    const sshTargetId = getSshTargetIdForExecutionHost(args.hostId)
    if (sshTargetId) {
      throw sshTargetNotServedError(sshTargetId)
    }
    const repo = await this.deps.addRepo(args.path, kind, args.hostId)
    const repoWasCreated = !knownRepoIds.has(repo.id)
    // Stored remotes may predate user-added ones; probe current Git state.
    const folderRemote =
      repoWasCreated && repo.gitRemoteIdentity !== undefined
        ? repo
        : await readCurrentGitRemoteIdentity(repo)
    return this.completeSetup(args, repo, repoWasCreated, folderRemote)
  }

  /** Keep repo.addRemote registered for older clients, but refuse unserved SSH targets with guidance for adding them on the right host. */
  addSshRepo(args: { connectionId: string }): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    throw new SshHostNotServedError(args.connectionId, SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE)
  }

  async setupClone(args: ProjectHostSetupCloneArgs): Promise<ProjectHostSetupResult> {
    assertCloneHostIsSupported(args.hostId)
    const knownRepoIds = new Set(this.deps.listRepos().map((repo) => repo.id))
    const repo = await this.deps.cloneRepo(args.url, args.destination, args.hostId)
    return this.completeSetup(
      { ...args, path: repo.path, kind: 'git', setupMethod: 'cloned' },
      repo,
      !knownRepoIds.has(repo.id),
      // Fresh-clone remote is unprobed; Git-remote linking needs that fact.
      repo.gitRemoteIdentity === undefined ? await readCurrentGitRemoteIdentity(repo) : repo
    )
  }

  // Refuse unavailable/WSL-moving projects before any Git probe.
  updateSetup(args: ProjectHostSetupUpdateArgs): Promise<ProjectHostSetupUpdateResult> {
    const store = this.deps.getStore()
    const updateProjectHostSetup = store?.updateProjectHostSetup?.bind(store)
    if (!store || !updateProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    assertWslMoveHostSetupIdWritable(store, args)
    return this.finishSetupUpdate(store, updateProjectHostSetup, args)
  }

  private async finishSetupUpdate(
    store: RuntimeStore,
    updateProjectHostSetup: NonNullable<RuntimeStore['updateProjectHostSetup']>,
    args: ProjectHostSetupUpdateArgs
  ): Promise<ProjectHostSetupUpdateResult> {
    const result = await updateProjectHostSetupWithProvenKind(
      store,
      (setupArgs) => {
        assertWslMoveHostSetupIdWritable(store, setupArgs)
        return updateProjectHostSetup(setupArgs)
      },
      args,
      true
    )
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`)
    }
    if ('worktreeBasePath' in args.updates && result.repo) {
      void prepareLocalWorktreeRootForRepo(store, result.repo)
      invalidateAuthorizedRootsCache()
    }
    if (result.repo && ('path' in args.updates || 'kind' in args.updates)) {
      this.retireRepoCatalog(result.repo.id)
    }
    this.deps.invalidateResolvedWorktrees()
    this.deps.notifyReposChanged()
    return result
  }

  deleteSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult {
    const store = this.deps.getStore()
    if (!store?.deleteProjectHostSetup) {
      throw new Error('runtime_unavailable')
    }
    assertWslMoveHostSetupIdWritable(store, args)
    if (args.force === false) {
      this.assertSetupRemovalIsUnused(store, args)
    }
    const result = store.deleteProjectHostSetup(args)
    if (!result) {
      throw new Error(`Project host setup not found: ${args.setupId}`)
    }
    if (result.repo) {
      this.retireRepoCatalog(result.repo.id)
    }
    this.deps.invalidateResolvedWorktrees()
    this.deps.notifyReposChanged()
    return result
  }

  // Invalidate shared repo-id scan caches on desktop and runtime, regardless of path/kind.
  private retireRepoCatalog(repoId: string): void {
    runWorktreeChangeInvalidators(repoId)
    invalidateAuthorizedRootsCache()
  }

  // Only explicit force:false adds refusal; omission preserves older clients' delete behavior.
  private assertSetupRemovalIsUnused(store: RuntimeStore, target: ProjectHostSetupTarget): void {
    const setup = findProjectHostSetup(this.listSetups(), target)
    // Measure the exact host row the store will delete, never its same-id sibling.
    const repo = setup?.repoId
      ? this.deps
          .listRepos()
          .find(
            (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
          )
      : undefined
    if (!repo) {
      return
    }
    const refusal = describeProjectRemovalRefusal({
      liveTerminals: this.deps.countLiveTerminalsForRepo(repo),
      workspacesWithMetadata: countRepoWorkspacesWithMetadata(
        repo,
        // Read host-qualified: sibling same-path rows may exist only in canonical maps.
        readAllWorktreeMetaForRepo(store, repo)
      )
    })
    if (refusal) {
      throw new Error(refusal)
    }
  }

  private completeSetup(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
    repoWasCreated: boolean,
    folderRemote: Pick<Repo, 'gitRemoteIdentity'>
  ): ProjectHostSetupResult {
    try {
      return this.linkRepo(args, initialRepo, folderRemote)
    } catch (error) {
      if (repoWasCreated) {
        // Rollback must remove only this host's row, never a same-id sibling.
        this.deps.getStore()?.removeProjectForHost?.(initialRepo)
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
    initialRepo: Repo,
    folderRemote: Pick<Repo, 'gitRemoteIdentity'>
  ): ProjectHostSetupResult {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    assertWslMoveHostSetupWritable(store, {
      projectId: args.projectId,
      hostId: getRepoExecutionHostId(initialRepo),
      repoId: initialRepo.id
    })
    let repo = initialRepo
    let setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    if (setup.projectId !== args.projectId) {
      const existingProject = this.listProjects().find((project) => project.id === args.projectId)
      const updated = store.updateRepo(
        repo,
        resolveImportedFolderProjectLink(
          folderRemote,
          args.projectId,
          existingProject?.providerIdentity ?? args.projectProviderIdentity
        )
      )
      if (!updated) {
        throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
      }
      repo = updated
      setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    }
    const setupMethod = args.setupMethod ?? 'imported-existing-folder'
    const updated = store.updateRepo(repo, { projectHostSetupMethod: setupMethod })
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
