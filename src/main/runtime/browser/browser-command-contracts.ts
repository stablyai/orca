import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { BrowserNetworkExecutionHost } from '../../../shared/browser-network-execution-host'
import type { BrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import type { BrowserWindow } from 'electron'
import type { BrowserBackend } from '../../browser/browser-backend'
import type { BrowserSessionTabSelectionOptions } from '../browser-tab-create-publication'
import type { ServeBrowserTabs } from '../serve-browser-tabs'

export type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

export type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

export type ResolvedBrowserPageWebContents = {
  browserPageId: string
  webContents: Electron.WebContents
}

export type RuntimeBrowserCommandHost = {
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorktreeSelector(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserWorkspace(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserNetworkExecutionHost(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost>
  getBrowserHostLeaseRegistry(): BrowserHostLeaseRegistry
  getRuntimeBrowserPageRegistry(): RuntimeBrowserPageRegistry
  getAuthoritativeWindow(): BrowserWindow
  getAvailableAuthoritativeWindow(): BrowserWindow | null
  // Why: headless serve backs pages with a main-process offscreen backend; null when the environment can't support offscreen browsing.
  getOffscreenBrowserBackend(): BrowserBackend | null
  // Why: the session-tab snapshot owns focus, so a headless create must mark itself active or paired clients snap back to a terminal.
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    options?: BrowserSessionTabSelectionOptions
  ): void
  notifyHeadlessBrowserSessionTabsChanged?(worktreeId: string): void
  /** True when a runtime-owned session row for that page existed and was retired. */
  retireRuntimeOwnedBrowserSessionTab?(worktreeId: string, browserPageId: string): boolean | void
  /** Saved browser tabs on a host with no window; their writes and starts do nothing with one. */
  serveBrowserTabs?: Pick<ServeBrowserTabs, 'opened' | 'start'>
}
