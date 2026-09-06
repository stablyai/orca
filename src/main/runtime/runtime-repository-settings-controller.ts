import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeRepositorySettingsDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: string) => Promise<Repo>
  forgetTerminalTopology: (repoId: string) => void
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

type RepositoryUpdates = Partial<
  Pick<
    Repo,
    | 'displayName'
    | 'badgeColor'
    | 'repoIcon'
    | 'upstream'
    | 'hookSettings'
    | 'worktreeBaseRef'
    | 'worktreeBasePath'
    | 'kind'
    | 'symlinkPaths'
    | 'issueSourcePreference'
    | 'externalWorktreeVisibility'
    | 'externalWorktreeVisibilityPromptDismissedAt'
    | 'externalWorktreeInboxBaselinePaths'
    | 'importedExternalWorktreePaths'
    | 'agentWorktreeVisibility'
    | 'projectGroupId'
    | 'projectGroupOrder'
  >
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

export class RuntimeRepositorySettingsController {
  constructor(private readonly deps: RuntimeRepositorySettingsDependencies) {}

  async show(repoSelector: string): Promise<Repo> {
    return await this.deps.resolveRepo(repoSelector)
  }

  async setBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    const store = this.requireStore()
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = store.updateRepo(repo.id, { worktreeBaseRef: baseRef })
    if (!updated) {
      throw new Error('repo_not_found')
    }
    this.deps.invalidateResolvedWorktrees()
    this.deps.notifyReposChanged()
    return updated
  }

  async update(repoSelector: string, updates: RepositoryUpdates): Promise<Repo> {
    const store = this.requireStore()
    const repo = await this.deps.resolveRepo(repoSelector)
    const sanitizedUpdates = omitUndefined(updates)
    if ('worktreeBasePath' in updates && updates.worktreeBasePath === undefined) {
      sanitizedUpdates.worktreeBasePath = undefined
    }
    if (
      'externalWorktreeDiscoverySuppressedAt' in updates &&
      updates.externalWorktreeDiscoverySuppressedAt === null
    ) {
      sanitizedUpdates.externalWorktreeDiscoverySuppressedAt = undefined
    }
    if ('sourceControlAi' in updates && updates.sourceControlAi === null) {
      sanitizedUpdates.sourceControlAi = null
    }
    const updated = store.updateRepo(repo.id, sanitizedUpdates)
    if (!updated) {
      throw new Error('repo_not_found')
    }
    if ('worktreeBasePath' in updates) {
      await prepareLocalWorktreeRootForRepo(store, updated)
      invalidateAuthorizedRootsCache()
    }
    this.deps.invalidateResolvedWorktrees()
    if ('worktreeBasePath' in updates) {
      this.deps.invalidateWorktreeScan(repo.id)
    }
    this.deps.notifyReposChanged()
    return updated
  }

  async remove(repoSelector: string): Promise<{ removed: true }> {
    const store = this.deps.getStore()
    if (!store?.removeProject) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const hostId = getRepoExecutionHostId(repo)
    const idExistsOnOtherHost = store
      .getRepos()
      .some((entry) => entry.id === repo.id && getRepoExecutionHostId(entry) !== hostId)
    if (idExistsOnOtherHost) {
      if (!store.removeProjectForHost) {
        throw new Error('runtime_unavailable')
      }
      store.removeProjectForHost(repo.id, hostId)
    } else {
      store.removeProject(repo.id)
    }
    this.deps.forgetTerminalTopology(repo.id)
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repo.id)
    invalidateAuthorizedRootsCache()
    this.deps.notifyReposChanged()
    return { removed: true }
  }

  reorder(orderedIds: string[]): { status: 'applied' | 'rejected' } {
    const store = this.deps.getStore()
    if (!store?.reorderRepos) {
      throw new Error('runtime_unavailable')
    }
    if (!store.reorderRepos(orderedIds)) {
      return { status: 'rejected' }
    }
    this.deps.invalidateResolvedWorktrees()
    this.deps.notifyReposChanged()
    return { status: 'applied' }
  }

  private requireStore(): RuntimeStore {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return store
  }
}
