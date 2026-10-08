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
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { resolveEditorAuthority } from './editor-authority'
import { openHostDiffTab, openHostEditFileTab } from './host-editor-tab-commands'
import { getHostEditorTabState } from './host-editor-tab-state'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'

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
    captureEditorAuthority: () => resolveEditorAuthority(this),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation, context) => {
      if (context?.authority === 'host') {
        openHostEditFileTab(this, {
          worktreeId,
          filePath,
          relativePath,
          executionHostId: context.executionHostId,
          navigation
        })
        return
      }
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation)
    },
    openDiff: (
      worktreeId,
      filePath,
      relativePath,
      staged,
      runtimeEnvironmentId,
      navigation,
      context
    ) => {
      if (context?.authority === 'host') {
        openHostDiffTab(this, {
          worktreeId,
          filePath,
          relativePath,
          staged,
          executionHostId: context.executionHostId,
          navigation
        })
        return
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

  protected async writeHostMarkdownFile(args: {
    worktreeId: string
    relativePath: string
    content: string
    executionHostId: string
    sshTargetId: string | undefined
    sshConnectionGeneration: number | undefined
    beforeWrite: () => void
  }): Promise<void> {
    await this.fileCommands.writeFileExplorerFile(
      `id:${args.worktreeId}`,
      args.relativePath,
      args.content,
      args.sshConnectionGeneration,
      args.sshTargetId,
      args.executionHostId,
      args.beforeWrite
    )
  }

  // Why: a promoted window whose hand-over timed out or failed keeps a live document that may still
  // persist the session it read; only a closed window or a gone renderer cannot.
  hasLiveWindowDocument(): boolean {
    for (const windowId of [this.authoritativeWindowId, this.pendingHeadlessPromotionWindowId]) {
      if (windowId === null || windowId === HEADLESS_RUNTIME_WINDOW_ID) {
        continue
      }
      const win = getRuntimeDesktopSurface().findWindowById(windowId)
      if (
        win &&
        !win.isDestroyed() &&
        win.webContents?.isDestroyed?.() !== true &&
        win.webContents?.isCrashed?.() !== true
      ) {
        return true
      }
    }
    return false
  }

  // Why: projection is synchronous, so the root comes from the workspace id or its folder record.
  getHostEditorWorkspaceRoot(worktreeId: string): string | null {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      return (
        this.store
          ?.getFolderWorkspaces?.()
          .find((workspace) => workspace.id === scope.folderWorkspaceId)?.folderPath ?? null
      )
    }
    return splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
  }

  // Why: diffs are never persisted, so a window taking editor authority starts without them.
  protected retireHostEditorDiffTabsForWindowTakeover(): void {
    for (const worktreeId of getHostEditorTabState(this).clearAllDiffs()) {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (snapshot) {
        this.storeMobileSessionSnapshot(worktreeId, {
          ...snapshot,
          snapshotVersion: snapshot.snapshotVersion + 1,
          tabs: snapshot.tabs.filter((tab) => tab.type !== 'file' || tab.mode !== 'diff')
        })
      }
    }
  }

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
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
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
