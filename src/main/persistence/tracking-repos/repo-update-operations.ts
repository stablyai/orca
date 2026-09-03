import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../shared/external-worktree-visibility'
import { normalizeRepoSourceControlAiOverrides } from '../../../shared/source-control-ai'
import { normalizeWorktreeVisibilitySourcePreferences } from '../../../shared/worktree/visibility-sources'
import { sanitizeRepoUpdatesForPersistence } from './repo-sanitization'
import { isFolderRepo } from '../../../shared/repo-kind'

export type RepoUpdateMutationOperations = {
  state: PersistedState
  bumpLocalWorktreeScanGeneration: (repoId: string) => void
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
  hydrateRepo: (repo: Repo) => Repo
}

export class RepoUpdatePersistenceOperations {
  constructor(private readonly operations: RepoUpdateMutationOperations) {}

  private get state(): PersistedState {
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
        | 'spotlightTestingEnabled'
        | 'projectHostSetupMethod'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    },
    hostId?: ExecutionHostId
  ): Repo | null {
    const repo = this.state.repos.find(
      (candidate) =>
        candidate.id === id && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
    if (!repo) {
      return null
    }
    const sanitizedUpdates = sanitizeRepoUpdatesForPersistence(updates)
    if (
      sanitizedUpdates.spotlightTestingEnabled === true &&
      (isFolderRepo(repo) || Boolean(repo.connectionId?.trim()))
    ) {
      // Spotlight testing is local-git only; the service refuses folder/SSH
      // repos and the settings UI hides the toggle for them. Drop a stray enable
      // (e.g. from a runtime RPC client) so it can't persist a flag that only
      // injects a dead ORCA_SPOTLIGHT_LOG with no UI to turn it back off.
      delete sanitizedUpdates.spotlightTestingEnabled
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
    Object.assign(repo, sanitizedUpdates)
    this.bumpLocalWorktreeScanGeneration(id)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }
}
