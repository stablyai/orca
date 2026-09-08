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
import type { WorktreeCreateResult } from '../tasks/worktree-create-retry'
import type { WorktreeCreateIdempotencyProbe } from '../tasks/worktree-create-idempotency-policy'
import type { NewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import type {
  MrStateFilter,
  MobileComposerCreateSelection
} from '../tasks/mobile-composer-source-types'
import type {
  ComposerHostedBase,
  ResolveComposerMrBaseArgs,
  ResolveComposerPrBaseArgs
} from '../tasks/composer-source-base-resolve'
import type { WorkspaceAgentChoice } from '../tasks/workspace-agent-selection'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { SetupHookTrust } from '../tasks/setup-hook-trust'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { GitRemoteIdentity } from '../../../src/shared/git-remote-identity'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'

export type NewWorkspaceRepository = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  executionHostLabel?: string
  projectId?: string
  kind?: 'git' | 'folder'
  upstream?: { owner: string; repo: string; host?: string } | null
  repoIcon?: RepoIcon | null
  gitRemoteIdentity?: GitRemoteIdentity | null
}

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

export type CreateBlankWorkspaceOperationArgs = {
  repoId: string
  baseName: string
  agentChoice: WorkspaceAgentChoice
  nameWasGenerated: boolean
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
}

export type CreateWorkspaceFromSourceOperationArgs = {
  selection: MobileComposerCreateSelection
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agentChoice: WorkspaceAgentChoice
  workspaceName: string | undefined
  note: string | undefined
  sparseCheckout?: { directories: string[]; presetId?: string }
  nameIsAutoManaged?: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
}

export type HostWorkspaceCreationOperations = {
  listRepositories(): Promise<NewWorkspaceRepository[]>
  readRetiredWorktreeNames(repoId: string): Promise<RetiredNameRegistry>
  readRuntimeSettings(): Promise<NewWorkspaceRuntimeSettings>
  readTrustedHooks(): Promise<PersistedTrustedOrcaHooks>
  isGitLabCliInstalled(): Promise<boolean>
  isLinearConnected(): Promise<boolean>
  readSshState(targetId: string): Promise<SshConnectionState>
  connectSsh(targetId: string): Promise<SshConnectionState>
  detectAgents(connectionId: string | null): Promise<string[]>
  readRepoHooks(repoId: string): Promise<NewWorkspaceRepoHooks>
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
  createBlankWorkspace(args: CreateBlankWorkspaceOperationArgs): Promise<WorktreeCreateResult>
  createWorkspaceFromSource(
    args: CreateWorkspaceFromSourceOperationArgs
  ): Promise<WorktreeCreateResult>
}
