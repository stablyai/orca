import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'
import type { LocalProjectGhExecOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { OrcaRuntimeWithPreservedBranchCleanup } from './runtime-host-services'
import { createRuntimeFileWatcherRemoval } from '../workspaces/removal/runtime-file-watcher-removal'
import {
  isChatScratchWorktreeId,
  resolveChatScratchSelectorFolder
} from '../files/chat-scratch-file-root'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from '../workspaces/catalog/runtime-worktree-path-identity'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeRepoSelector } from '../workspaces/catalog/runtime-repo-selector'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../terminal/layout/runtime-layout-apply'
import { createRuntimeEditorFileOpener } from '../files/editor-open-through-layout-owner'
import { resolveNativeChatMediaPath } from '../../native-chat/native-chat-media-path'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { RuntimeFileSearch } from '../files/search/file-search'
import { RuntimeTerminalArtifacts } from '../terminal/artifacts/terminal-artifacts'
import { RuntimeFileAccess } from '../files/file-access'
import { RuntimeFileReads } from '../files/file-reads'
import { RuntimeFileMutations } from '../files/file-mutations'
import { RuntimeStagedFileSaves } from '../files/staged-file-save-commands'
import { RuntimeFileWatches } from '../files/watch/file-watches'
import { RuntimeTerminalPathResolver } from '../terminal/terminal-path-resolver'
import type { RuntimeFileCommandHost } from '../files/file-command-host'

export abstract class OrcaRuntimeWithFileCommands extends OrcaRuntimeWithPreservedBranchCleanup {
  protected abstract hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options?: { force?: boolean }
  ): Set<string>
  abstract notifyMobileSessionTabsChanged(worktreeId: string): void
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
  abstract resolveTerminalFileUriHostname(handle: string): string | null
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

  protected abstract resolveRepoSelector(selector: RuntimeRepoSelector): Promise<Repo>

  protected readonly runtimeFileCommandHost: RuntimeFileCommandHost = {
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveRuntimeFileTarget: async (selector) => {
      // Scratch folders are file-only; the general resolver also places chats.
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
    resolveTerminalFileUriHostname: (terminalHandle) =>
      this.resolveTerminalFileUriHostname(terminalHandle),
    resolveNativeChatMediaPath: (request) => {
      const host = getStructuredAgentSessionHost()
      return resolveNativeChatMediaPath(request, {
        getConversation: (id) => host?.deps.store.getConversation(id),
        getSessionTabId: (id) => host?.getSessionTabId(id),
        providerRows: (tabId) => this.getAgentProviderSessionRows(tabId)
      })
    },
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    openFile: createRuntimeEditorFileOpener({
      getNotifier: () => this.notifier,
      applyLayoutCommand: (command) => this.applyLayoutCommand(command),
      groupFor: (id) => this.editorOpenGroupFor(id),
      publishHeadlessTabs: (id) => {
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(id, { force: true })
        this.notifyMobileSessionTabsChanged(id)
      }
    }),
    openDiff: (
      worktreeId,
      filePath,
      relativePath,
      staged,
      runtimeEnvironmentId,
      navigation,
      oldPath
    ) => {
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
        navigation,
        ...(oldPath ? ([oldPath] as const) : [])
      )
    }
  }

  protected readonly fileSearch = new RuntimeFileSearch(this.runtimeFileCommandHost)

  protected readonly terminalArtifacts = new RuntimeTerminalArtifacts(this.runtimeFileCommandHost)

  protected readonly fileAccess = new RuntimeFileAccess(this.runtimeFileCommandHost)

  protected readonly fileReads = new RuntimeFileReads(this.runtimeFileCommandHost)

  protected readonly fileMutations = new RuntimeFileMutations(this.runtimeFileCommandHost)

  protected readonly stagedFileSaveCommands = new RuntimeStagedFileSaves(
    this.runtimeFileCommandHost
  )

  protected readonly fileWatches = new RuntimeFileWatches(this.runtimeFileCommandHost)

  protected readonly terminalPaths = new RuntimeTerminalPathResolver(
    this.runtimeFileCommandHost,
    this.terminalArtifacts
  )

  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  protected abstract editorOpenGroupFor(worktreeId: string): string | undefined

  protected readonly fileWatcherRemoval = createRuntimeFileWatcherRemoval(this.fileWatches)

  closeFileWatchersForRemoval = this.fileWatcherRemoval.close

  restoreFileWatchersAfterFailedRemoval = this.fileWatcherRemoval.restore

  forgetFileWatchersAfterRemoval = this.fileWatcherRemoval.forget

  acquireFileWatcherRemoval = this.fileWatcherRemoval.acquire
}
