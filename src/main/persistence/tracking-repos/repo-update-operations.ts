import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../shared/external-worktree-visibility'
import { normalizeRepoSourceControlAiOverrides } from '../../../shared/source-control-ai'
import { normalizeWorktreeVisibilitySourcePreferences } from '../../../shared/worktree/visibility-sources'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import type { RepoAgentAccounts } from '../../../shared/claude/project-claude-account-preference'
import { invalidateGhAccountTokenCache } from '../../github/gh-account-token'
import { sanitizeRepoUpdatesForPersistence } from './repo-sanitization'

export type RepoUpdateMutationOperations = {
  state: Pick<PersistedState, 'repos' | 'projectGroups'>
  bumpLocalWorktreeScanGeneration: (repoId: string) => void
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
  hydrateRepo: (repo: Repo) => Repo
}

/**
 * Resolve the row a host-scoped write may touch, and report the one failure the `Repo | null` return
 * cannot express: the row exists, but under a different host stamp.
 *
 * `hostId` is the row's own `executionHostId`, never the host a caller probed or a user selected. A
 * caller that passes anything else gets the same `null` as a deleted row, so its write is discarded
 * with no error and no failing test — how #22421 shipped an enrichment pass that never persisted.
 */
export function findRepoRowForHostScopedWrite(
  repos: readonly Repo[],
  id: string,
  hostId: ExecutionHostId | undefined
): Repo | undefined {
  if (!hostId) {
    return repos.find((candidate) => candidate.id === id)
  }
  const matched = repos.find(
    (candidate) => candidate.id === id && getRepoExecutionHostId(candidate) === hostId
  )
  if (matched) {
    return matched
  }
  const storedHostIds = repos
    .filter((candidate) => candidate.id === id)
    .map((candidate) => getRepoExecutionHostId(candidate))
  if (storedHostIds.length > 0) {
    console.error(
      `[persistence] Discarded a repo update for ${id}: requested host ${hostId}, but the row is stored on ${storedHostIds.join(', ')}. Address updateRepo by the row's own executionHostId stamp.`
    )
  }
  return undefined
}

export class RepoUpdatePersistenceOperations {
  constructor(private readonly operations: RepoUpdateMutationOperations) {}

  private get state(): Pick<PersistedState, 'repos' | 'projectGroups'> {
    return this.operations.state
  }

  private bumpLocalWorktreeScanGeneration(repoId: string): void {
    this.operations.bumpLocalWorktreeScanGeneration(repoId)
  }

  private syncProjectHostSetupCompatibilityState(): void {
    this.operations.syncProjectHostSetupCompatibilityState()
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

  private hydrateRepo(repo: Repo): Repo {
    return this.operations.hydrateRepo(repo)
  }

  updateRepo(
    id: string,
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'gitRemoteIdentity'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'folderUpgradeGitRootPath'
        | 'executionHostId'
        | 'symlinkPaths'
        | 'issueSourcePreference'
        | 'forkSyncMode'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'customWorktreeVisibilitySources'
        | 'worktreeVisibilitySourcePreferences'
        | 'projectGroupId'
        | 'projectGroupOrder'
        | 'projectHostSetupMethod'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
      ghAccount?: GhAccountBinding | null
      agentAccounts?: RepoAgentAccounts | null
    },
    hostId?: ExecutionHostId
  ): Repo | null {
    const repo = findRepoRowForHostScopedWrite(this.state.repos, id, hostId)
    if (!repo) {
      return null
    }
    const previousGhAccount = repo.ghAccount
    const sanitizedUpdates = sanitizeRepoUpdatesForPersistence(updates)
    if (
      'executionHostId' in updates &&
      getRepoExecutionHostId({ ...repo, ...updates }) !== getRepoExecutionHostId(repo)
    ) {
      delete repo.folderUpgradeGitRootPath
      delete sanitizedUpdates.folderUpgradeGitRootPath
    }
    if (
      'agentWorktreeVisibility' in sanitizedUpdates &&
      !('worktreeVisibilitySourcePreferences' in sanitizedUpdates) &&
      (sanitizedUpdates.agentWorktreeVisibility === 'hide' ||
        sanitizedUpdates.agentWorktreeVisibility === 'show')
    ) {
      // Why normalize: the stored value is spread in as-is, so a legacy/corrupt custom map would be
      // written straight back without passing the same validation as a renderer-supplied patch.
      const preferences = normalizeWorktreeVisibilitySourcePreferences({
        ...repo.worktreeVisibilitySourcePreferences,
        builtIn: {
          claude: sanitizedUpdates.agentWorktreeVisibility,
          gsd: sanitizedUpdates.agentWorktreeVisibility
        }
      })
      if (preferences) {
        sanitizedUpdates.worktreeVisibilitySourcePreferences = preferences
      }
    }
    if ('projectGroupId' in sanitizedUpdates) {
      const nextGroupId = sanitizedUpdates.projectGroupId
      if (
        typeof nextGroupId !== 'string' ||
        nextGroupId.trim().length === 0 ||
        !this.state.projectGroups.some((group) => group.id === nextGroupId)
      ) {
        sanitizedUpdates.projectGroupId = null
      }
    }
    if (
      'projectGroupOrder' in sanitizedUpdates &&
      (typeof sanitizedUpdates.projectGroupOrder !== 'number' ||
        !Number.isFinite(sanitizedUpdates.projectGroupOrder))
    ) {
      delete sanitizedUpdates.projectGroupOrder
    }
    const externalWorktreeVisibilityLegacy =
      'externalWorktreeVisibility' in sanitizedUpdates &&
      repo.externalWorktreeVisibilityLegacy === undefined
        ? isLegacyRepoForExternalWorktreeVisibility(repo)
        : undefined
    // Why: selected repo fields use `undefined` as an explicit clear signal, so delete them before assigning the patch.
    if (
      'issueSourcePreference' in sanitizedUpdates &&
      sanitizedUpdates.issueSourcePreference === undefined
    ) {
      delete repo.issueSourcePreference
      delete sanitizedUpdates.issueSourcePreference
    }
    if ('ghAccount' in sanitizedUpdates && sanitizedUpdates.ghAccount == null) {
      delete repo.ghAccount
      delete sanitizedUpdates.ghAccount
    }
    if ('agentAccounts' in sanitizedUpdates && sanitizedUpdates.agentAccounts == null) {
      delete repo.agentAccounts
      delete sanitizedUpdates.agentAccounts
    }
    if ('worktreeBasePath' in sanitizedUpdates && sanitizedUpdates.worktreeBasePath === undefined) {
      delete repo.worktreeBasePath
      delete sanitizedUpdates.worktreeBasePath
    }
    if (
      'externalWorktreeVisibility' in sanitizedUpdates &&
      (sanitizedUpdates.externalWorktreeVisibility === undefined ||
        sanitizedUpdates.externalWorktreeVisibility === null)
    ) {
      delete repo.externalWorktreeVisibility
      repo.externalWorktreeVisibilityLegacy = false
      delete sanitizedUpdates.externalWorktreeVisibility
    }
    if (
      'agentWorktreeVisibility' in sanitizedUpdates &&
      sanitizedUpdates.agentWorktreeVisibility === null
    ) {
      delete repo.agentWorktreeVisibility
      delete sanitizedUpdates.agentWorktreeVisibility
    }
    if (
      'externalWorktreeVisibility' in sanitizedUpdates &&
      repo.externalWorktreeVisibilityLegacy === undefined
    ) {
      // Why: old persisted repos have no marker; stamp it on first visibility change so later hide/show keeps legacy safety.
      repo.externalWorktreeVisibilityLegacy = externalWorktreeVisibilityLegacy
    }
    if (
      'externalWorktreeDiscoverySuppressedAt' in sanitizedUpdates &&
      (sanitizedUpdates.externalWorktreeDiscoverySuppressedAt === undefined ||
        sanitizedUpdates.externalWorktreeDiscoverySuppressedAt === null)
    ) {
      delete repo.externalWorktreeDiscoverySuppressedAt
      delete sanitizedUpdates.externalWorktreeDiscoverySuppressedAt
    }
    if (
      'sourceControlAi' in sanitizedUpdates &&
      (sanitizedUpdates.sourceControlAi === undefined || sanitizedUpdates.sourceControlAi === null)
    ) {
      delete repo.sourceControlAi
      delete sanitizedUpdates.sourceControlAi
    } else if ('sourceControlAi' in sanitizedUpdates) {
      const normalizedSourceControlAi = normalizeRepoSourceControlAiOverrides(
        sanitizedUpdates.sourceControlAi
      )
      if (normalizedSourceControlAi === undefined) {
        delete sanitizedUpdates.sourceControlAi
      } else {
        sanitizedUpdates.sourceControlAi = normalizedSourceControlAi
      }
    }
    if ('ghAccount' in updates) {
      // Why: a rebind or unbind must not reuse a token cached for the previous login.
      invalidateGhAccountTokenCache(previousGhAccount)
      if (sanitizedUpdates.ghAccount) {
        invalidateGhAccountTokenCache(sanitizedUpdates.ghAccount)
      }
    }
    Object.assign(repo, sanitizedUpdates)
    this.bumpLocalWorktreeScanGeneration(id)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }
}
