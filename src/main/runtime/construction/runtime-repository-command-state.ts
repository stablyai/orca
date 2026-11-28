import type { Repo } from '../../../shared/repository/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { runtimeVisibleRepos } from '../workspaces/catalog/runtime-visible-catalog'
import type { RuntimeTerminalAgentStatus } from '../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { HostPRCache } from '../../github/pull-requests/refresh/host-pr-cache-backfill'
import { RuntimeGitCommands } from '../integrations/git/orca-runtime-git'
import {
  LazyRuntimeGitHubRepositoryQueryCommands,
  LazyRuntimeHostedReviewCommands,
  LazyRuntimeRepositoryHooksCommands,
  LazyRuntimeRepositoryIssueCommand
} from '../repositories/lazy-runtime-repository-review-commands'
import {
  LazyRuntimeGitLabMutationCommands,
  LazyRuntimeGitLabQueryCommands
} from '../integrations/gitlab/lazy-runtime-gitlab-commands'
import { recordGitLabProjectRecent } from '../../gitlab/projects/gitlab-project-recents'
import {
  LazyRuntimeGitHubIssueCommentCommands,
  LazyRuntimeGitHubProjectCommands,
  LazyRuntimeGitHubReviewMutationCommands,
  LazyRuntimeGitHubReviewQueryCommands
} from '../integrations/github/lazy-runtime-github-review-commands'
import { ClientHostedBrowserRowPublisher } from '../browser/client-pages/client-hosted-browser-row-publication'
import { getRuntimeBrowserPageRegistry } from '../browser/client-pages/runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../browser-host/leases/browser-host-lease-registry-instance'
import { isWslMoveWorktreeBlocked } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import { worktreeRowTarget } from '../../persistence/host-qualified-worktree-meta'
import {
  createBranchSwitchHost,
  storeBackedBranchSwitchSources
} from '../integrations/git/runtime-branch-switch-host'
import { OrcaRuntimeWithFileCommands } from './runtime-file-command-state'
import { getWorktreeCreatePrefetchGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { projectGroupHookOwner } from '../../../shared/workspace-setup/hooks/workspace-hook-owner'

export abstract class OrcaRuntimeWithRepositoryCommands extends OrcaRuntimeWithFileCommands {
  protected readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    getRuntimeSettings: () => this.requireStore().getSettings(),
    getCommitMessageAgentEnvironment: () => this.accounts.getCommitMessageAgentEnvironment(),
    // Override the resolver's one-second linked-issue cache so template generation sees link/unlink immediately.
    getWorktreeLinkedIssue: (worktreeId) => {
      const store = this.store
      // Unreadable means unknown: undefined retains cached linkedIssue; null would suppress it.
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
    // #17828/#17842: materialized git-sync has no store; persist remoteCreated here for orphan cleanup.
    persistMaterializedPushTarget: (worktree, pushTarget) => {
      const store = this.store
      const target = store ? worktreeRowTarget(store, worktree) : undefined
      if (!store || !target || isWslMoveWorktreeBlocked(target.id, target.hostId)) {
        return
      }
      store.setWorktreeMeta(target, { pushTarget })
    },
    ...createBranchSwitchHost({
      getStore: () => this.store,
      readAgentRows: () => this.getAgentStatusSnapshotFn?.() ?? [],
      readAgentPaneRows: (paneKey) => this.getAgentStatusSnapshotForPaneFn?.(paneKey) ?? [],
      ptys: () => this.ptysById.values(),
      paneOf: (pty) => this.paneOfPty(pty),
      terminalHandlesOf: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId),
      hasSyncedTab: (tabId) => this.tabs.has(tabId),
      ...storeBackedBranchSwitchSources(() => this.store),
      probeProcess: (paneKey) => this.checkHookAgentPresenceFn?.(paneKey) ?? Promise.resolve(null),
      notifyBranchChanged: (repoId) => this.notifyBranchRenamed(repoId)
    })
  })

  protected abstract getExistingTerminalHandlesForPtyId(ptyId: string): string[]

  abstract notifyBranchRenamed(repoId: string): void

  /** Remote views consume raw bytes even with a hidden desktop; resync daemon marks so those streams are never thinned. */
  onRemoteTerminalViewPresenceChanged: ((ptyId: string) => void) | null = null

  protected readonly interactiveWaitProbesByPtyId = new Map<
    string,
    Promise<RuntimeTerminalAgentStatus | undefined>
  >()

  // Keystroke bursts share a cached proven-absent verdict instead of probing per send.
  protected readonly provenAbsentLeafPtyVerdicts = new Map<string, number>()

  protected readonly leafPtyAbsenceProbes = new Map<string, Promise<boolean>>()

  protected readonly hostedReviews = new LazyRuntimeHostedReviewCommands({
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
    },
    recordPROutcome: (...args) => this.hostPRCache?.record(...args)
  })

  /** Set only on a renderer-less host (orcad), whose served PR reads must fill its own cache. */
  hostPRCache: HostPRCache | null = null

  /** The rows orcad's PR cache backfill reads; the resolved snapshot is shared with worktree.ps. */
  async listHostPRCacheWorktrees(): Promise<{ worktrees: readonly Worktree[]; repos: Repo[] }> {
    return { worktrees: await this.listResolvedWorktrees(), repos: runtimeVisibleRepos(this.store) }
  }

  protected readonly gitHubRepositoryQueries = new LazyRuntimeGitHubRepositoryQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitLabQueryCommands = new LazyRuntimeGitLabQueryCommands({
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

  protected readonly gitLabMutationCommands = new LazyRuntimeGitLabMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubReviewQueries = new LazyRuntimeGitHubReviewQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubReviewMutations = new LazyRuntimeGitHubReviewMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubIssueComments = new LazyRuntimeGitHubIssueCommentCommands({
    resolveTarget: (args) => this.resolveHostedReviewTarget(args),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubProjectCommands = new LazyRuntimeGitHubProjectCommands()

  protected readonly repositoryHooks = new LazyRuntimeRepositoryHooksCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    resolveProjectGroupOwner: (groupId) => {
      const group = this.store?.getProjectGroups?.().find((entry) => entry.id === groupId)
      return group ? projectGroupHookOwner(group) : null
    },
    readCreateSourceHooks: async (repo, source) => {
      const { readCreateSourceSetupHooks } =
        await import('../../workspace-hooks/create-source-setup-hooks')
      return readCreateSourceSetupHooks({
        repo,
        source,
        runtime: this.remoteFetches,
        gitOptions: getWorktreeCreatePrefetchGitOptions(this.requireStore(), repo)
      })
    }
  })

  protected readonly repositoryIssueCommand = new LazyRuntimeRepositoryIssueCommand({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo),
    getStore: () => this.store
  })

  protected readonly clientHostedBrowserRows = new ClientHostedBrowserRowPublisher({
    listClientPages: (worktreeId) => getRuntimeBrowserPageRegistry(this).listPages(worktreeId),
    getClientPage: (browserPageId) => getRuntimeBrowserPageRegistry(this).getPage(browserPageId),
    hasLivePlacement: (browserPageId) =>
      getBrowserHostLeaseRegistry(this).getPlacement(browserPageId) !== undefined,
    resolveDeviceName: (pairedDeviceId) => this.getPairedDeviceNameFn(pairedDeviceId),
    getEmitter: () => {
      const notifier = this.notifier
      const send = notifier?.clientHostedBrowserRowsChanged
      return send ? (event) => send.call(notifier, event) : null
    }
  })

  protected readonly persistedClientHostedBrowserWorktreeIds = new Set<string>()
}
