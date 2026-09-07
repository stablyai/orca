// @ts-nocheck -- mechanically split class members.
import type {
  BrowserCommandTargetParams,
  ResolvedBrowserCommandTarget,
  ResolvedBrowserPageWebContents,
  RuntimeBrowserCommandHost
} from './runtime-browser-commands-browser-command-target-params'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { BrowserError } from '../browser/browser-error'
import { webContents } from 'electron'
import {
  waitForTabRegistration,
  waitForWorktreeTabRegistration
} from '../ipc/browser-tab-registration-wait'
import type { BrowserSnapshotResult } from '../../shared/runtime-types'
import { RuntimeBrowserCommandsState } from './runtime-browser-commands-state'

export class RuntimeBrowserCommandsWithActiveScreencastsByPageId extends RuntimeBrowserCommandsState {
  constructor(private readonly host: RuntimeBrowserCommandHost) {
    super()
  }

  protected requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  /**
   * Retires a session row for a page nothing here can close any more.
   *
   * A client-hosted page whose runtime record is gone -- released as unrecoverable, or created by a
   * build that kept its records in memory only -- still leaves a row every paired device can see,
   * and every close path below is keyed on a live guest this runtime does not have. Without this
   * the row's X fails closed and the ghost outlives the browser it named.
   */
  private retireGhostBrowserSessionRow(
    worktreeId: string | undefined,
    browserPageId: string
  ): boolean {
    return (
      worktreeId !== undefined &&
      this.host.retireRuntimeOwnedBrowserSessionTab?.(worktreeId, browserPageId) === true
    )
  }

  protected hasLiveRegisteredBrowserTab(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined
  ): boolean {
    for (const [, webContentsId] of bridge.getRegisteredTabs(worktreeId)) {
      const guest = webContents.fromId(webContentsId)
      if (guest && !guest.isDestroyed()) {
        return true
      }
    }
    return false
  }

  protected hasLiveRegisteredBrowserPage(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined,
    browserPageId: string
  ): boolean {
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (webContentsId == null) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    return Boolean(guest && !guest.isDestroyed())
  }

  // Why: the CLI sends selectors (e.g. "path:/...") but the bridge keys tabs by "repoId::path"; resolve to that store-compatible id.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after restart, webviews mount only when the pane is visible; activate the view so persisted tabs become operable via registerGuest.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, undefined)) {
        try {
          await this.ensureBrowserWorktreeActive(undefined)
        } catch {
          // Window may not exist yet (e.g. during startup or in tests)
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorktreeSelector(selector)).id
    // Why: explicit selectors are user intent, so resolution errors surface (not silently widen scope); only activation stays best-effort.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, worktreeId)) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {
        // Fall through with the validated worktree id so routing stays scoped to the caller's explicit selector.
      }
    }
    return worktreeId
  }

  protected async resolveBrowserCommandTarget(
    params: BrowserCommandTargetParams
  ): Promise<ResolvedBrowserCommandTarget> {
    const browserPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    if (!browserPageId) {
      return {
        worktreeId: await this.resolveBrowserWorktreeId(params.worktree)
      }
    }

    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)) {
      try {
        await this.ensureBrowserPageActive(worktreeId, browserPageId)
      } catch {
        // Fall through with the explicit page target; downstream routing surfaces a clear "tab not found" error if wake fails.
      }
    }
    return {
      // Why: an explicit browserPageId is already a stable tab identity, so don't auto-resolve cwd worktree scoping on top of it.
      worktreeId,
      browserPageId
    }
  }

  protected resolveBrowserPageWebContents(
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): ResolvedBrowserPageWebContents {
    const bridge = this.requireAgentBrowserBridge()
    const resolvedPageId = browserPageId ?? bridge.getActivePageId(worktreeId)
    if (!resolvedPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(resolvedPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} was not found${scope}`
      )
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} is no longer available`
      )
    }
    return { browserPageId: resolvedPageId, webContents: guest }
  }

  // Why: background-mount the worktree via a hidden visibility lease so the webview guest can register without stealing the user's visible pane.
  private async ensureBrowserWorktreeActive(worktreeId: string | undefined): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send('browser:activateView', worktreeId ? { worktreeId } : {})
    // Why: the pane is operable only after the webview mounts and calls registerGuest; wait on that IPC rather than a flaky fixed sleep.
    await waitForWorktreeTabRegistration(worktreeId)
  }

  protected async ensureBrowserPageActive(
    worktreeId: string | undefined,
    browserPageId: string
  ): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send(
      'browser:activateView',
      worktreeId ? { worktreeId, browserPageId } : { browserPageId }
    )
    await waitForTabRegistration(browserPageId)
  }

  // Why: helper-driven clicks can bypass Electron navigation events; push authoritative URL/title updates after automation.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Why: carry worktreeId (not a global setActiveWorktree) so one agent's --focus can't steal the screen from another agent's parallel worktree.
  private notifyRendererBrowserPaneFocus(
    worktreeId: string | undefined,
    browserPageId: string
  ): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:pane-focus', {
        worktreeId: worktreeId ?? null,
        browserPageId
      })
    } catch {
      // Window may not exist during shutdown
    }
  }

  async browserSnapshot(params: BrowserCommandTargetParams): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(target.worktreeId, target.browserPageId)
  }
}
