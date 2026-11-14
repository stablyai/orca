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
} from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getProjectHostSetupForRepo } from '../../../shared/project-host-setup-lookup'
import {
  linkImportedFolderToProject,
  type RepositoryMetadataOwner
} from '../../workspaces/catalog/imported-folder-project-link'
import { invalidateAuthorizedRootsCache } from '../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { runWorktreeChangeInvalidators } from '../../ipc/worktrees/listing/worktree-change-invalidators'
import { prepareLocalWorktreeRootForRepo } from '../../workspaces/creation/worktree-root-preparation'
import { updateProjectHostSetupWithProvenKind } from '../../workspaces/catalog/folder-repo-git-conversion'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { readAllWorktreeMetaForRepo } from '../../persistence/host-qualified-worktree-meta'
import { readCurrentGitRemoteIdentity } from '../../workspaces/catalog/repo-git-remote-identity'
import {
  countRepoWorkspacesWithMetadata,
  describeProjectRemovalRefusal
} from '../workspaces/removal/project-removal-impact'
import {
  assertWslMoveHostSetupIdWritable,
  assertWslMoveHostSetupWritable,
  assertWslMoveReposWritable
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { runtimeVisibleProjectHostSetups } from '../workspaces/catalog/runtime-visible-catalog'
import { assertNoProjectWorktreeCreate } from '../../workspaces/creation/worktree-create-in-flight'
import { releaseWorktreeCreatePreparationsForRepo } from '../../workspaces/creation/preparation/worktree-create-preparation-project-removal'
import {
  findProjectHostSetup,
  SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE,
  type ProjectHostSetupTarget
} from '../../../shared/project-host-setup-target'

type RuntimeProjectHostSetupDependencies = RepositoryMetadataOwner & {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
  addRepo: (path: string, kind: 'folder' | 'git', hostId: ExecutionHostId) => Promise<Repo>
  cloneRepo: (args: ProjectHostSetupCloneArgs) => Promise<Repo>
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

function sshTargetNotServedError(connectionId: string): SshHostNotServedError {
  return new SshHostNotServedError(connectionId, SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE)
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
    const repo = await this.deps.cloneRepo(args)
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
    const repo = this.findSetupRepo(args)
    if (repo) {
      assertNoProjectWorktreeCreate(repo)
      if (args.force === false) {
        this.assertSetupRemovalIsUnused(store, repo)
      }
      releaseWorktreeCreatePreparationsForRepo(store, repo)
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

  // The exact host row the store will delete, never its same-id sibling.
  private findSetupRepo(target: ProjectHostSetupTarget): Repo | undefined {
    const setup = findProjectHostSetup(this.listSetups(), target)
    return setup?.repoId
      ? this.deps
          .listRepos()
          .find(
            (entry) => entry.id === setup.repoId && getRepoExecutionHostId(entry) === setup.hostId
          )
      : undefined
  }

  // Only explicit force:false adds refusal; omission preserves older clients' delete behavior.
  private assertSetupRemovalIsUnused(store: RuntimeStore, repo: Repo): void {
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

  private async completeSetup(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
    repoWasCreated: boolean,
    folderRemote: Pick<Repo, 'gitRemoteIdentity'>
  ): Promise<ProjectHostSetupResult> {
    try {
      const result = await this.linkRepo(args, initialRepo, folderRemote)
      this.deps.notifyReposChanged()
      return result
    } catch (error) {
      if (repoWasCreated) {
        // Rollback must remove only this host's row, never a same-id sibling.
        this.deps.getStore()?.removeProjectForHost?.(initialRepo)
        this.deps.invalidateResolvedWorktrees()
        this.deps.invalidateWorktreeScan(initialRepo.id)
        invalidateAuthorizedRootsCache()
      }
      this.deps.notifyReposChanged()
      throw error
    }
  }

  private async linkRepo(
    args: ProjectHostSetupExistingFolderArgs,
    initialRepo: Repo,
    folderRemote: Pick<Repo, 'gitRemoteIdentity'>
  ): Promise<ProjectHostSetupResult> {
    const repo = await linkImportedFolderToProject(
      this.deps.getStore,
      initialRepo,
      folderRemote,
      args,
      this.deps
    )
    const setup = getProjectHostSetupForRepo(this.listSetups(), repo)
    const project = this.listProjects().find((entry) => entry.id === setup.projectId)
    if (!project) {
      throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
    }
    return { project, setup, repo }
  }
}
