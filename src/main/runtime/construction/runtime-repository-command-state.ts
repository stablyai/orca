import type { RuntimeTerminalAgentStatus } from '../../../shared/terminal/runtime/runtime-terminal-contracts'
import { RuntimeGitCommands } from '../integrations/git/orca-runtime-git'
import { RuntimeHostedReviewCommands } from '../integrations/reviews/runtime-hosted-review-commands'
import { RuntimeGitHubRepositoryQueryCommands } from '../integrations/github/runtime-github-repository-query-commands'
import { RuntimeGitLabQueryCommands } from '../integrations/gitlab/runtime-gitlab-query-commands'
import { recordGitLabProjectRecent } from '../../gitlab/projects/gitlab-project-recents'
import { RuntimeGitLabMutationCommands } from '../integrations/gitlab/runtime-gitlab-mutation-commands'
import { RuntimeGitHubReviewQueryCommands } from '../integrations/github/runtime-github-review-query-commands'
import { RuntimeGitHubReviewMutationCommands } from '../integrations/github/runtime-github-review-mutation-commands'
import { RuntimeGitHubIssueCommentCommands } from '../integrations/github/runtime-github-issue-comment-commands'
import { RuntimeGitHubProjectCommands } from '../integrations/github/runtime-github-project-commands'
import { RuntimeRepositoryHooksCommands } from '../repositories/runtime-repository-hooks-commands'
import { RuntimeRepositoryIssueCommand } from '../repositories/runtime-repository-issue-command'
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
import { readCreateSourceSetupHooks } from '../../workspace-hooks/create-source-setup-hooks'
import { getWorktreeCreatePrefetchGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { isFloatingWorkspaceSelector } from '../../../shared/workspace/identity/floating-workspace-worktree'
import {
  modelDiscoveryExecutionHost,
  modelDiscoveryWorkspaceForHost
} from '../integrations/git/model-discovery-execution-host'
import { modelDiscoveryWslDistro } from '../integrations/git/model-discovery-workspace-runtime'
import type { ModelDiscoveryWorkspace } from '../integrations/git/runtime-git-command-target'

export abstract class OrcaRuntimeWithRepositoryCommands extends OrcaRuntimeWithFileCommands {
  protected readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    resolveModelDiscoveryWorkspace: (selector) => this.modelDiscoveryWorkspace(selector),
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

  /** Folder workspaces and SSH hosts use the terminal's scope, not the git-worktree catalog. */
  private async modelDiscoveryWorkspace(selector: string): Promise<ModelDiscoveryWorkspace> {
    const scope = await this.resolveTerminalWorkspaceLaunchScope(selector, undefined, {
      readOnly: true
    })
    // A terminal scope's connectionId is null for `runtime:` git and is the nested SSH id for a
    // `runtime:` folder. Keep the execution host and refuse anything this process cannot serve.
    const executionHostId = modelDiscoveryExecutionHost({
      folder: scope.folderWorkspace,
      gitExecutionHostId: scope.folderWorkspace
        ? null
        : isFloatingWorkspaceSelector(selector)
          ? LOCAL_EXECUTION_HOST_ID
          : (await this.resolveRuntimeGitTarget(selector)).executionHostId
    })
    const hosted = modelDiscoveryWorkspaceForHost({ path: scope.path, executionHostId })
    if (hosted.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return hosted
    }
    const wslDistro = modelDiscoveryWslDistro(this.requireStore(), scope)
    return wslDistro ? { ...hosted, wslDistro } : hosted
  }

  /** Remote views consume raw bytes even with a hidden desktop; resync daemon marks so those streams are never thinned. */
  onRemoteTerminalViewPresenceChanged: ((ptyId: string) => void) | null = null

  protected readonly interactiveWaitProbesByPtyId = new Map<
    string,
    Promise<RuntimeTerminalAgentStatus | undefined>
  >()

  // Keystroke bursts share a cached proven-absent verdict instead of probing per send.
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
    resolveTarget: (args) => this.resolveHostedReviewTarget(args),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  protected readonly gitHubProjectCommands = new RuntimeGitHubProjectCommands()

  protected readonly repositoryHooks = new RuntimeRepositoryHooksCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    readCreateSourceHooks: (repo, source) =>
      readCreateSourceSetupHooks({
        repo,
        source,
        runtime: this.remoteFetches,
        gitOptions: getWorktreeCreatePrefetchGitOptions(this.requireStore(), repo)
      })
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

  protected readonly persistedClientHostedBrowserWorktreeIds = new Set<string>()
}
