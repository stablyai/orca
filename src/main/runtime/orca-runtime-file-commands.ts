// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPreservedBranchCleanup } from './orca-runtime-preserved-branch-cleanup'
import { RuntimeFileCommands } from './orca-runtime-files'
import { nativeChatTranscriptIncludesPath } from '../native-chat/native-chat-file-provenance'
import { createRuntimeFileWatcherRemoval } from './runtime-file-watcher-removal'
import { RuntimeGitCommands } from './orca-runtime-git'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'
import { RuntimeGitHubRepositoryQueryCommands } from './runtime-github-repository-query-commands'
import { RuntimeGitLabQueryCommands } from './runtime-gitlab-query-commands'
import { recordGitLabProjectRecent } from '../gitlab/gitlab-project-recents'
import { RuntimeGitLabMutationCommands } from './runtime-gitlab-mutation-commands'
import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import { RuntimeGitHubReviewMutationCommands } from './runtime-github-review-mutation-commands'
import { RuntimeGitHubIssueCommentCommands } from './runtime-github-issue-comment-commands'
import { RuntimeGitHubProjectCommands } from './runtime-github-project-commands'
import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

export class OrcaRuntimeWithFileCommands extends OrcaRuntimeWithPreservedBranchCleanup {
  protected readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
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
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId) => {
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(worktreeId, filePath, relativePath, runtimeEnvironmentId)
    },
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId) => {
      if (!this.notifier?.openDiff) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openDiff(worktreeId, filePath, relativePath, staged, runtimeEnvironmentId)
    }
  })

  protected readonly fileWatcherRemoval = createRuntimeFileWatcherRemoval(this.fileCommands)

  closeFileWatchersForRemoval = this.fileWatcherRemoval.close

  restoreFileWatchersAfterFailedRemoval = this.fileWatcherRemoval.restore

  forgetFileWatchersAfterRemoval = this.fileWatcherRemoval.forget

  acquireFileWatcherRemoval = this.fileWatcherRemoval.acquire

  protected readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    getRuntimeSettings: () => this.requireStore().getSettings() as GlobalSettings,
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
    persistMaterializedPushTarget: (worktreeId, pushTarget) => {
      const store = this.store
      if (!store?.setWorktreeMeta) {
        return
      }
      store.setWorktreeMeta(worktreeId, { pushTarget })
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

  // Why: probe dedupe shares one promise across callers, but each caller's
  // continuation would re-deliver the same unread rows; arm one per pty.
  protected readonly probeDeferredDeliveryPtyIds = new Set<string>()

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
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })

  protected readonly orchestrationPointerAdmissionByPtyId = new Map<
    string,
    AgentSessionPtyWriteAdmittance
  >()

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

  // Why: the whole pointer→Enter span must be single-flight per pty. Triggers
  // landing mid-flight park their mailbox and re-run once on settle. The
  // flight object is the settle identity: a stale settle surviving an exit
  // retire must not clear a newer same-id flight or flush its parked trigger.
  protected readonly messageDeliveryFlightsByPtyId = new Map<
    string,
    { enterTimer: ReturnType<typeof setTimeout> | null }
  >()

  protected readonly parkedMessageRedeliveriesByPtyId = new Map<
    string,
    Map<string, { leaf: RuntimeLeafRecord; reservedTypes?: ReadonlySet<string> }>
  >()
}
