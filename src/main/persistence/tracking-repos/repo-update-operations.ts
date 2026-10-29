import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../shared/external-worktree-visibility'
import { normalizeRepoSourceControlAiOverrides } from '../../../shared/source-control-ai'
import { normalizeWorktreeVisibilitySourcePreferences } from '../../../shared/worktree/visibility-sources'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import { invalidateGhAccountTokenCache } from '../../github/gh-account-token'
import { sanitizeRepoUpdatesForPersistence } from './repo-sanitization'
import { isFolderRepo } from '../../../shared/repo-kind'
import { findExtraFolderWorkspaceIds } from '../../folder-workspace-meta-presence'

export type RepoUpdateMutationOperations = {
  state: Pick<PersistedState, 'repos' | 'projectGroups' | 'worktreeMeta'>
  bumpLocalWorktreeScanGeneration: (repoId: string) => void
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
  hydrateRepo: (repo: Repo) => Repo
}

/** Use the stored row's host stamp; distinguish host mismatch from missing rows so enrichment cannot silently disappear (#22421). */
export function findRepoRowForHostScopedWrite(
  repos: readonly Repo[],
  id: string,
  hostId: ExecutionHostId
): Repo | undefined {
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

/** Switching to git-only listing must not hide folder workspaces and trigger saved-tab purging. */
function assertKindChangeKeepsFolderWorkspaces(
  repo: Repo,
  nextKind: Repo['kind'] | undefined,
  worktreeMeta: PersistedState['worktreeMeta']
): void {
  if (nextKind !== 'git' || !isFolderRepo(repo)) {
    return
  }
  const count = findExtraFolderWorkspaceIds(repo, worktreeMeta).length
  if (count > 0) {
    throw new Error(
      `This folder project has ${count} other workspace${count === 1 ? '' : 's'} that a Git project can't show, so its type was not changed. Delete ${count === 1 ? 'that workspace' : 'those workspaces'} first, or keep it as a folder project.`
    )
  }
}

export class RepoUpdatePersistenceOperations {
  constructor(private readonly operations: RepoUpdateMutationOperations) {}

  private get state(): Pick<PersistedState, 'repos' | 'projectGroups' | 'worktreeMeta'> {
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
    target: RepoHostTarget,
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
        | 'defaultJiraProject'
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
    }
  ): Repo | null {
    const repo = findRepoRowForHostScopedWrite(
      this.state.repos,
      target.id,
      getRepoExecutionHostId(target)
    )
    if (!repo) {
      return null
    }
    assertKindChangeKeepsFolderWorkspaces(repo, updates.kind, this.state.worktreeMeta)
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
      // Validate merged legacy preferences too or corrupt stored maps bypass patch validation.
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
    // Delete explicit-undefined clear fields before assigning the sanitized patch.
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
      // Stamp legacy visibility safety once so later toggles retain it.
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
      // Rebind/unbind must invalidate credentials cached for the old account.
      invalidateGhAccountTokenCache(previousGhAccount)
      if (sanitizedUpdates.ghAccount) {
        invalidateGhAccountTokenCache(sanitizedUpdates.ghAccount)
      }
    }
    Object.assign(repo, sanitizedUpdates)
    this.bumpLocalWorktreeScanGeneration(repo.id)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }
}
