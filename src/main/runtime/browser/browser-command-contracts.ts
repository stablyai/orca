import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { BrowserNetworkExecutionHost } from '../../../shared/browser-network-execution-host'
import type { BrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import type { BrowserWindow } from 'electron'
import type { BrowserBackend } from '../../browser/browser-backend'
import type { BrowserSessionTabSelectionOptions } from '../browser-tab-create-publication'
import type { ServeBrowserTabs } from '../serve-browser-tabs'
import type { BrowserTabBarEntry } from './browser-tab-listing'

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
  getRuntimeId(): string
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorkspaceSelector(selector: string): Promise<{
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
  /** Headless offscreen backend, or null where unsupported. */
  getOffscreenBrowserBackend(): BrowserBackend | null
  // Update snapshot focus or paired clients snap back to a terminal.
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    options?: BrowserSessionTabSelectionOptions
  ): void
  notifyHeadlessBrowserSessionTabsChanged?(worktreeId: string): void
  /** The tab bar's browser tabs, loaded or not, from the published session snapshot. */
  readBrowserTabBar?(worktreeId: string | undefined): BrowserTabBarEntry[]
  retireRuntimeOwnedBrowserSessionTab?(worktreeId: string, browserPageId: string): boolean | void
  /** Persist/start only when no host window exists; hasStartable reads saved tabs either way. */
  serveBrowserTabs?: Pick<ServeBrowserTabs, 'opened' | 'start' | 'hasStartable'>
}
