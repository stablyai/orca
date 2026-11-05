import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../../session-tabs/session-tabs-change-publication'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../../../shared/mobile-markdown-document'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  readMarkdownTabFromDisk,
  saveMarkdownTabToDisk,
  type ListedMarkdownTab,
  type MarkdownTabDiskHost
} from './markdown-tab-disk-documents'
import { createMarkdownTabDiskHost } from './markdown-tab-disk-host'
import { RuntimeMobileSessionTabOrder } from '../../session-tabs/mobile-session-tab-order'
export abstract class RuntimeMarkdownTabOperations extends RuntimeMobileSessionTabOrder {
  abstract resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }>

  protected abstract resolveMobileMarkdownWorktreeId(
    ...args: Parameters<
      OrcaRuntimeWithScheduleMobileSessionTabsChanged['resolveMobileMarkdownWorktreeId']
    >
  ): ReturnType<OrcaRuntimeWithScheduleMobileSessionTabsChanged['resolveMobileMarkdownWorktreeId']>

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    return await readMarkdownTabFromDisk(
      this.markdownTabDiskHost(),
      worktreeId,
      this.listedMarkdownTab(worktreeId, tabId)
    )
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    return await saveMarkdownTabToDisk(
      this.markdownTabDiskHost(),
      worktreeId,
      this.listedMarkdownTab(worktreeId, tabId),
      baseVersion,
      content
    )
  }

  private listedMarkdownTab(worktreeId: string, tabId: string): ListedMarkdownTab {
    const tab = this.mobileSessionTabsByWorktree
      .get(worktreeId)
      ?.tabs.find((candidate) => candidate.type === 'markdown' && candidate.id === tabId)
    if (tab?.type !== 'markdown') {
      throw new Error('tab_not_found')
    }
    return tab
  }

  private markdownTabDiskHost(): MarkdownTabDiskHost {
    return createMarkdownTabDiskHost({
      requireStore: () => this.requireStore(),
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId),
      resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
      callEnvironment: (environmentId, method, params, expectedPairingRevision) =>
        this.callOrchestrationWorkerServer(
          environmentId,
          method,
          params,
          undefined,
          undefined,
          expectedPairingRevision === undefined
            ? undefined
            : { expectedEnvironmentPairingRevision: expectedPairingRevision }
        ),
      environmentPairingRevision: (environmentId) =>
        this.resolveOrchestrationWorkerServer(environmentId).pairingRevision
    })
  }
}
