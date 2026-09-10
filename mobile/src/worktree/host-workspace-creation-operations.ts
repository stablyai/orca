import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { BaseRefSearchResult } from '../../../src/shared/repo-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { SparsePreset } from '../../../src/shared/worktree/create-types'
import type { GitHubPrStartPoint } from '../../../src/shared/worktree/types'
import type { RepoSlug } from '../../../src/shared/new-workspace/github-links'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { NewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import type { MrStateFilter } from '../tasks/mobile-composer-source-types'
import type {
  ComposerHostedBase,
  ResolveComposerMrBaseArgs,
  ResolveComposerPrBaseArgs
} from '../tasks/composer-source-base-resolve'
import type { SetupHookTrust } from '../tasks/setup-hook-trust'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'

import type { MobileWorkspaceRepo } from '../components/new-worktree-modal-types'

export type { MobileWorkspaceRepo as NewWorkspaceRepository } from '../components/new-worktree-modal-types'

export type NewWorkspaceRuntimeSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
  visibleTaskProviders?: unknown
}

export type NewWorkspaceRepoHooks = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
  setupTrust?: SetupHookTrust
}

export type HostWorkspaceCreationOperations = {
  listRepositories(): Promise<MobileWorkspaceRepo[]>
  readRetiredWorktreeNames(repoId: string): Promise<RetiredNameRegistry>
  /** Null when the host answers without a settings key: the caller keeps what it has. */
  readRuntimeSettings(): Promise<NewWorkspaceRuntimeSettings | null>
  readTrustedHooks(): Promise<PersistedTrustedOrcaHooks>
  isGitLabCliInstalled(): Promise<boolean>
  isLinearConnected(): Promise<boolean>
  /** Null when the host knows nothing about the target, which is not the same as disconnected. */
  readSshState(targetId: string): Promise<SshConnectionState | null>
  connectSsh(targetId: string): Promise<SshConnectionState>
  detectAgents(connectionId: string | null): Promise<string[]>
  readRepoHooks(repoId: string): Promise<NewWorkspaceRepoHooks>
  /** Null when the host refuses the read. The create sheet keeps whatever it already showed
   *  rather than replacing it with a "no setup script" answer it cannot stand behind. */
  readRepoHooksIfAvailable(repoId: string): Promise<NewWorkspaceRepoHooks | null>
  readRuntimeCapabilities(): Promise<NewWorktreeRuntimeCapabilities>
  listSparsePresets(repoId: string): Promise<SparsePreset[]>
  saveSparsePreset(
    repoId: string,
    payload: { id?: string; name: string; directories: string[] }
  ): Promise<SparsePreset>
  persistSetupTrust(args: {
    trust: PersistedTrustedOrcaHooks
    repoId: string
    contentHash: string
    alwaysTrust: boolean
  }): Promise<PersistedTrustedOrcaHooks>
  searchGitHubItems(repoId: string, query: string): Promise<GitHubWorkItem[]>
  searchGitLabItems(repoId: string, query: string, state: MrStateFilter): Promise<GitLabWorkItem[]>
  searchLinearIssues(
    query: string,
    linearWorkspaceId: string | null | undefined
  ): Promise<LinearIssue[]>
  searchBranches(repoId: string, query: string): Promise<BaseRefSearchResult[]>
  resolveGitHubRepoSlug(repoId: string): Promise<{ supported: boolean; slug: RepoSlug | null }>
  lookupGitHubItem(repoId: string, number: number): Promise<GitHubWorkItem | null>
  lookupGitHubItemByOwnerRepo(args: {
    repoId: string
    slug: RepoSlug
    number: number
    type: 'issue' | 'pr'
  }): Promise<GitHubWorkItem | null>
  lookupGitLabItemByPath(args: {
    repoId: string
    host: string
    path: string
    iid: number
    type: 'issue' | 'mr'
  }): Promise<GitLabWorkItem | null>
  resolvePrBase(args: Omit<ResolveComposerPrBaseArgs, 'client'>): Promise<GitHubPrStartPoint>
  resolveMrBase(args: Omit<ResolveComposerMrBaseArgs, 'client'>): Promise<ComposerHostedBase>
}
