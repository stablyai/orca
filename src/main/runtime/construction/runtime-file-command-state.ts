import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'
import type { LocalProjectGhExecOptions } from '../../project-runtime-git-options'
import type { RuntimeTerminalAgentStatus } from '../../../shared/runtime-terminal-contracts'
import { OrcaRuntimeWithPreservedBranchCleanup } from './runtime-host-services'
import { RuntimeFileCommands } from '../orca-runtime-files'
import { nativeChatTranscriptIncludesPath } from '../../native-chat/native-chat-file-provenance'
import { createRuntimeFileWatcherRemoval } from '../runtime-file-watcher-removal'
import { RuntimeGitCommands } from '../orca-runtime-git'
import { RuntimeHostedReviewCommands } from '../runtime-hosted-review-commands'
import { RuntimeGitHubRepositoryQueryCommands } from '../runtime-github-repository-query-commands'
import { RuntimeGitLabQueryCommands } from '../runtime-gitlab-query-commands'
import { recordGitLabProjectRecent } from '../../gitlab/gitlab-project-recents'
import { RuntimeGitLabMutationCommands } from '../runtime-gitlab-mutation-commands'
import { RuntimeGitHubReviewQueryCommands } from '../runtime-github-review-query-commands'
import { RuntimeGitHubReviewMutationCommands } from '../runtime-github-review-mutation-commands'
import { RuntimeGitHubIssueCommentCommands } from '../runtime-github-issue-comment-commands'
import { RuntimeGitHubProjectCommands } from '../runtime-github-project-commands'
import { RuntimeRepositoryHooksCommands } from '../runtime-repository-hooks-commands'
import { RuntimeRepositoryIssueCommand } from '../runtime-repository-issue-command'
import { ClientHostedBrowserRowPublisher } from '../client-hosted-browser-row-publication'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry-instance'
import {
  isChatScratchWorktreeId,
  resolveChatScratchSelectorFolder
} from '../files/chat-scratch-file-root'

import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { Repo } from '../../../shared/repo-types'
import { isWslMoveWorktreeBlocked } from '../../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { worktreeRowTarget } from '../../persistence/host-qualified-worktree-meta'

export abstract class OrcaRuntimeWithFileCommands extends OrcaRuntimeWithPreservedBranchCleanup {
  abstract resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }>
  protected abstract floatingWorkspaceToResolvedWorktree(path: string): ResolvedWorktree
  protected abstract resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
    relativePath: string
  } | null>
  abstract resolveTerminalCwd(handle: string): Promise<string | null>
  abstract resolveTerminalContext(handle: string): {
    worktreeId: string
    connectionId: string | null
  } | null
  abstract resolveTerminalFileUriHostname(handle: string): string | null
  abstract hasRecentTerminalOutputPath(
    handle: string,
    pathText: string,
    absolutePath: string
  ): boolean
  protected abstract getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult
  protected abstract resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    executionHostId: ExecutionHostId
    localGitOptions?: {
      wslDistro?: string
    }
  }>
  protected abstract resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{
    repo: Repo
    repoPath: string
  }>
  protected abstract getHostedReviewExecutionOptions(
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ):
    | {
        localGitExecOptions: LocalProjectGhExecOptions & {
          admissionTier?: GitAdmissionTier
        }
      }
    | undefined
  protected abstract getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions]

  abstract requireStore(): RuntimeStore

  protected abstract resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree>

  protected abstract resolveRepoSelector(selector: string): Promise<Repo>

  protected readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeFileTarget: async (selector) => {
      // Why here, not in the general resolver: that one also places new chats, and a scratch folder
      // must never become a chat's workspace.
      const scratchFolder = await resolveChatScratchSelectorFolder(selector)
      return scratchFolder
        ? {
            worktree: { ...this.floatingWorkspaceToResolvedWorktree(scratchFolder), id: selector },
            executionHostId: LOCAL_EXECUTION_HOST_ID
          }
        : this.resolveRuntimeFileTarget(selector)
    },
    resolveKnownWorkspaceFileTarget: (absolutePath, executionHostId) =>
      this.resolveKnownWorkspaceFileTarget(absolutePath, executionHostId),
    resolveTerminalCwd: (terminalHandle) => this.resolveTerminalCwd(terminalHandle),
    resolveTerminalContext: (terminalHandle) => this.resolveTerminalContext(terminalHandle),
    resolveTerminalFileUriHostname: (terminalHandle) =>
      this.resolveTerminalFileUriHostname(terminalHandle),
    hasRecentTerminalOutputPath: (terminalHandle, pathText, absolutePath) =>
      this.hasRecentTerminalOutputPath(terminalHandle, pathText, absolutePath),
    hasRecentNativeChatOutputPath: (worktreeId, context, pathText, absolutePath) =>
      nativeChatTranscriptIncludesPath({
        tabs: this.getMobileSessionTabsForWorktree(worktreeId).tabs,
        context,
        pathText,
        absolutePath
      }),
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation, position) => {
      // The UI cannot open a tab in a workspace that has no row.
      if (isChatScratchWorktreeId(worktreeId)) {
        throw new Error('chat_scratch_not_openable')
      }
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId,
        navigation,
        ...(position ? [position] : [])
      )
    },
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId, navigation) => {
      if (isChatScratchWorktreeId(worktreeId)) {
        throw new Error('chat_scratch_not_openable')
      }
      if (!this.notifier?.openDiff) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openDiff(
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId,
        navigation
      )
    }
  })

  protected readonly fileWatcherRemoval = createRuntimeFileWatcherRemoval(this.fileCommands)

  closeFileWatchersForRemoval = this.fileWatcherRemoval.close

  restoreFileWatchersAfterFailedRemoval = this.fileWatcherRemoval.restore

  forgetFileWatchersAfterRemoval = this.fileWatcherRemoval.forget

  acquireFileWatcherRemoval = this.fileWatcherRemoval.acquire

  protected readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    getRuntimeSettings: () => this.requireStore().getSettings(),
    getCommitMessageAgentEnvironment: () => this.accounts.getCommitMessageAgentEnvironment(),
    // Why: resolved worktrees are cached for a second, so link/unlink would lag
    // generation; meta is keyed by the same id the resolver returns.
    getWorktreeLinkedIssue: (worktreeId) => {
      const store = this.store
      // Why: an unreadable store is "unknown", not "unlinked" — undefined keeps
      // the resolver's cached linkedIssue instead of suppressing {linkedIssue}.
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      return store.getWorktreeMeta(worktreeId)?.linkedIssue ?? null
    },
    getWorktreeLinkedIssueMeta: (worktreeId) => {
      const store = this.store
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      const meta = store.getWorktreeMeta(worktreeId)
      return meta
        ? {
            linkedIssue: meta.linkedIssue,
            linkedGitLabIssue: meta.linkedGitLabIssue,
            linkedWorkItem: meta.linkedWorkItem
          }
        : null
    },
    // Why (#17828 review follow-up): RuntimeGitSyncCommands materializes with no store to
    // avoid unrelated side effects; this is its only way back into the persisted
    // `pushTarget.remoteCreated` flag that #17842's orphan sweep relies on.
    persistMaterializedPushTarget: (worktree, pushTarget) => {
      const store = this.store
      const target = store ? worktreeRowTarget(store, worktree) : undefined
      // Bookkeeping incidental to the push: a project a WSL move is taking skips it, not the push.
      if (!store || !target || isWslMoveWorktreeBlocked(target.id, target.hostId)) {
        return
      }
      store.setWorktreeMeta(target, { pushTarget })
    }
  })

  /** Set by pty IPC: fires when a PTY gains/loses remote view subscribers so
   *  the daemon background mark (keep-tail stream thinning) can resync — a
   *  live mobile/web view consumes raw bytes and must never be thinned, even
   *  while the desktop pane is hidden. */
  onRemoteTerminalViewPresenceChanged: ((ptyId: string) => void) | null = null

  protected readonly interactiveWaitProbesByPtyId = new Map<
    string,
    Promise<RuntimeTerminalAgentStatus | undefined>
  >()

  // Why a cache: leaf-branch sends may arrive per keystroke; one proven-absent
  // verdict per ptyId serves the burst instead of a probe round-trip each call.
  protected readonly provenAbsentLeafPtyVerdicts = new Map<string, number>()

  protected readonly leafPtyAbsenceProbes = new Map<string, Promise<boolean>>()

  protected readonly hostedReviews = new RuntimeHostedReviewCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    resolveTarget: (args) => this.resolveHostedReviewTarget(args),
    getExecutionOptions: (repo, admissionTier) =>
      this.getHostedReviewExecutionOptions(repo, admissionTier),
    recordCreated: (repoId, number, url) => {
      if (!this.stats || this.stats.hasCountedPR(url)) {
        return
      }
      this.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId,
        meta: { prNumber: number, prUrl: url }
      })
    }
  })

  protected readonly gitHubRepositoryQueries = new RuntimeGitHubRepositoryQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitLabQueryCommands = new RuntimeGitLabQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo),
    recordProjectRecent: (projectRef) => {
      if (!this.store?.updateSettings) {
        return
      }
      const store = this.store
      recordGitLabProjectRecent(
        {
          getSettings: () => store.getSettings(),
          updateSettings: (updates) => store.updateSettings?.(updates)
        },
        projectRef.host,
        projectRef.path
      )
    }
  })

  protected readonly gitLabMutationCommands = new RuntimeGitLabMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubReviewQueries = new RuntimeGitHubReviewQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubReviewMutations = new RuntimeGitHubReviewMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubIssueComments = new RuntimeGitHubIssueCommentCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubProjectCommands = new RuntimeGitHubProjectCommands()

  protected readonly repositoryHooks = new RuntimeRepositoryHooksCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })

  protected readonly repositoryIssueCommand = new RuntimeRepositoryIssueCommand({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo),
    getStore: () => this.store
  })

  protected readonly clientHostedBrowserRows = new ClientHostedBrowserRowPublisher({
    listClientPages: (worktreeId) => getRuntimeBrowserPageRegistry(this).listPages(worktreeId),
    hasLivePlacement: (browserPageId) =>
      getBrowserHostLeaseRegistry(this).getPlacement(browserPageId) !== undefined,
    resolveDeviceName: (pairedDeviceId) => this.getPairedDeviceNameFn(pairedDeviceId),
    getEmitter: () => {
      const notifier = this.notifier
      const send = notifier?.clientHostedBrowserRowsChanged
      return send ? (event) => send.call(notifier, event) : null
    }
  })

  /** Worktrees whose persisted client-hosted rows this runtime is responsible for rewriting. */
  protected readonly persistedClientHostedBrowserWorktreeIds = new Set<string>()
}
