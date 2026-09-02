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
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { addsCheckoutOrigin } from '../../shared/git-remote-identity'
import {
  getCarriedCheckoutIdentityKey,
  getProjectIdentityKey,
  getProjectIdForProviderIdentity
} from '../../shared/project-host-setup-projection'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeProjectHostSetupDependencies = {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
  addRepo: (path: string, kind: 'folder' | 'git', hostId: ExecutionHostId) => Promise<Repo>
  cloneRepo: (url: string, destination: string, hostId: ExecutionHostId) => Promise<Repo>
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

function assertHostIsSupported(hostId: ExecutionHostId | null | undefined): void {
  if (parseExecutionHostId(hostId)?.kind !== 'ssh') {
    return
  }
  throw new Error(
    'SSH hosts are not supported by this operation. Set the project up from the Orca desktop app, which owns the SSH connection.'
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
    assertHostIsSupported(args.hostId)
    const knownRepoIds = new Set(this.deps.listRepos().map((repo) => repo.id))
    const repo = await this.deps.addRepo(
      args.path,
      args.kind === 'folder' ? 'folder' : 'git',
      args.hostId
    )
    return this.completeSetup(args, repo, !knownRepoIds.has(repo.id))
  }

  async setupClone(args: ProjectHostSetupCloneArgs): Promise<ProjectHostSetupResult> {
    assertHostIsSupported(args.hostId)
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

  /**
   * Merges a freshly registered repo into the project the request named — stamping the ancestor
   * identity or the carried checkout identity — and refuses when no stamp makes the derived id match.
   */
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
      // Why: mirrors `identity` above for checkout-keyed projects, which have no provider identity —
      // the target host may not have the project record yet, so the request's copy is the only source.
      const checkoutIdentity = existingProject?.gitRemoteIdentity ?? args.projectGitRemoteIdentity
      if (identity && getProjectIdForProviderIdentity(identity) === args.projectId) {
        const upstream = {
          owner: identity.owner,
          repo: identity.repo,
          ...(identity.host ? { host: identity.host } : {})
        }
        // Why re-check before writing: a stale gitRemoteIdentity on the repo outranks upstream in
        // getProjectIdentityKey, so stamping first could leave a mismatched upstream behind on throw.
        if (getProjectIdentityKey({ ...repo, upstream }) !== args.projectId) {
          throw new Error('Imported folder does not match the selected project identity.')
        }
        const updated = store.updateRepo(repo.id, { upstream })
        if (!updated) {
          throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
        }
        repo = updated
      } else if (
        checkoutIdentity &&
        (!repo.gitRemoteIdentity || addsCheckoutOrigin(repo.gitRemoteIdentity, checkoutIdentity)) &&
        getCarriedCheckoutIdentityKey(checkoutIdentity, identity) === args.projectId
      ) {
        // Why both: the checkout remote is what keys the project, and the ancestor metadata is what
        // qualifies a GHES id with its API port — the recheck below re-derives from the stored row.
        const updated = store.updateRepo(repo.id, {
          gitRemoteIdentity: checkoutIdentity,
          ...(identity
            ? {
                upstream: {
                  owner: identity.owner,
                  repo: identity.repo,
                  ...(identity.host ? { host: identity.host } : {})
                }
              }
            : {})
        })
        if (!updated) {
          throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
        }
        repo = updated
      } else {
        throw new Error('Imported folder does not match the selected project identity.')
      }
      setup = getProjectHostSetupForRepo(this.listSetups(), repo)
      if (getProjectIdentityKey(repo) !== args.projectId) {
        throw new Error('Imported folder does not match the selected project identity.')
      }
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
