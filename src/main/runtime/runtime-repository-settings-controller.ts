import { isFolderRepo } from '../../shared/repo-kind'
import { commitProvenRepoKindChange } from '../folder-repo-git-conversion'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeRepoSelector } from './runtime-repo-selector'
import type { GhAccountBinding } from '../../shared/github/account-binding'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { assertWslMoveRepoWritable } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { teardownStops } from './owned-session-teardown-policy'

const PROJECT_TERMINAL_STOP_BUDGET_MS = 10_000

type RuntimeRepositorySettingsDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: RuntimeRepoSelector) => Promise<Repo>
  forgetTerminalTopology: (repoId: string) => void
  /** Optional so test doubles and older wiring keep removing without it. */
  stopProjectTerminals?: (
    repo: Repo,
    options: { deadline: number; closeStructuredSessions: boolean }
  ) => Promise<unknown>
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
  notifyWorktreesChanged: (repoId: string, options: { invalidateGitScans: false }) => void
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
    | 'defaultJiraProject'
    | 'externalWorktreeVisibility'
    | 'externalWorktreeVisibilityPromptDismissedAt'
    | 'externalWorktreeInboxBaselinePaths'
    | 'importedExternalWorktreePaths'
    | 'agentWorktreeVisibility'
    | 'customWorktreeVisibilitySources'
    | 'worktreeVisibilitySourcePreferences'
    | 'projectGroupId'
    | 'projectGroupOrder'
  >
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
  /** Only `null` clears; `omitUndefined` drops a stripped (undefined) field so it never unbinds. */
  ghAccount?: GhAccountBinding | null
}

// Main computes each row's `visible` from these over cached raw Git scans, so re-list without rescanning.
const WORKTREE_VISIBILITY_INPUTS = [
  'externalWorktreeVisibility',
  'importedExternalWorktreePaths',
  'agentWorktreeVisibility',
  'worktreeBasePath',
  'customWorktreeVisibilitySources',
  'worktreeVisibilitySourcePreferences'
] as const satisfies readonly (keyof RepositoryUpdates)[]

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

export class RuntimeRepositorySettingsController {
  constructor(private readonly deps: RuntimeRepositorySettingsDependencies) {}

  async show(repoSelector: RuntimeRepoSelector): Promise<Repo> {
    return await this.deps.resolveRepo(repoSelector)
  }

  async setBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    const store = this.requireStore()
    const repo = await this.deps.resolveRepo(repoSelector)
    assertWslMoveRepoWritable(store, repo)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = store.updateRepo(repo, { worktreeBaseRef: baseRef })
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
    assertWslMoveRepoWritable(store, repo)
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
    const write = (proven: Pick<Repo, 'folderUpgradeGitRootPath'>): Repo | null => {
      assertWslMoveRepoWritable(store, repo)
      return store.updateRepo(repo, { ...sanitizedUpdates, ...proven })
    }
    const updated =
      sanitizedUpdates.kind === 'git' && isFolderRepo(repo)
        ? await commitProvenRepoKindChange(store, repo, write, true)
        : write({})
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
    if (WORKTREE_VISIBILITY_INPUTS.some((key) => key in updates)) {
      this.deps.notifyWorktreesChanged(repo.id, { invalidateGitScans: false })
    }
    return updated
  }

  /** `repo.rm` names a selector; this desktop's own removal names the exact host row. */
  async remove(target: string | Repo): Promise<{ removed: true }> {
    const store = this.deps.getStore()
    if (!store?.removeProjectForHost) {
      throw new Error('runtime_unavailable')
    }
    const repo = typeof target === 'string' ? await this.deps.resolveRepo(target) : target
    assertWslMoveRepoWritable(store, repo)
    // Host owns all shells; clients may stop only loaded workspaces or none. Bound teardown inside repo.rm timeout.
    const deadline = Date.now() + PROJECT_TERMINAL_STOP_BUDGET_MS
    const stopProjectTerminals = async (closeStructuredSessions: boolean): Promise<void> => {
      await this.deps
        .stopProjectTerminals?.(repo, { deadline, closeStructuredSessions })
        .catch((error: unknown) => {
          console.warn('[runtime] failed to stop project terminals on removal', error)
        })
    }
    await stopProjectTerminals(false)
    // Recheck WSL fence after stop awaits.
    assertWslMoveRepoWritable(store, repo)
    store.removeProjectForHost(repo)
    // Sweep again for terminals spawned during stop. Retire chats only after the final WSL fence because that step is irreversible.
    await stopProjectTerminals(teardownStops('project-removal', 'structured-chat'))
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
