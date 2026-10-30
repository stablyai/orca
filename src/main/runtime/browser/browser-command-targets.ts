import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import { BrowserError } from '../../browser/browser-error'
import { webContents } from 'electron'
import {
  waitForTabRegistration,
  waitForWorktreeTabRegistration
} from '../../ipc/browser-tab-registration-wait'
import type { BrowserSnapshotResult } from '../../../shared/runtime-types'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost,
  ResolvedBrowserCommandTarget,
  ResolvedBrowserPageWebContents
} from './browser-command-contracts'

export class RuntimeBrowserCommandTargets {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAgentBrowserBridge'
      | 'resolveWorkspaceSelector'
      | 'getAuthoritativeWindow'
      | 'retireRuntimeOwnedBrowserSessionTab'
      | 'serveBrowserTabs'
    >
  ) {}

  requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  retireGhostBrowserSessionRow(worktreeId: string | undefined, browserPageId: string): boolean {
    return (
      worktreeId !== undefined &&
      this.host.retireRuntimeOwnedBrowserSessionTab?.(worktreeId, browserPageId) === true
    )
  }

  private hasLiveRegisteredBrowserTab(
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

  private hasLiveRegisteredBrowserPage(
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

  // Resolve CLI selectors to the repoId::path keys the bridge uses.
  async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Persisted webviews register only after mounting; wake them before use.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, undefined)) {
        try {
          await this.ensureBrowserWorktreeActive(undefined)
        } catch {
          // Startup/tests may have no window.
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorkspaceSelector(selector)).id
    // Explicit selector failures must surface instead of widening scope; activation alone is best-effort.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, worktreeId)) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {}
    }
    return worktreeId
  }

  async resolveBrowserCommandTarget(
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
      ? (await this.host.resolveWorkspaceSelector(params.worktree)).id
      : undefined
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)) {
      try {
        await this.ensureBrowserPageActive(worktreeId, browserPageId)
      } catch {}
    }
    return {
      // Explicit page ids already provide stable scope; do not add cwd-derived worktree scope.
      worktreeId,
      browserPageId
    }
  }

  resolveBrowserPageWebContents(
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

  // Mount under a hidden visibility lease so automation cannot steal the visible pane.
  private async ensureBrowserWorktreeActive(worktreeId: string | undefined): Promise<void> {
    if (await this.host.serveBrowserTabs?.start(worktreeId, undefined)) {
      return
    }
    // With no saved tab the window mounts nothing, so the wait could only time out (#20434).
    if (this.host.serveBrowserTabs?.hasStartable(worktreeId) === false) {
      return
    }
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send('browser:activateView', worktreeId ? { worktreeId } : {})
    // Await registerGuest rather than guessing a fixed mount delay.
    await waitForWorktreeTabRegistration(worktreeId)
  }

  async ensureBrowserPageActive(
    worktreeId: string | undefined,
    browserPageId: string
  ): Promise<void> {
    if (await this.host.serveBrowserTabs?.start(worktreeId, browserPageId)) {
      return
    }
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send(
      'browser:activateView',
      worktreeId ? { worktreeId, browserPageId } : { browserPageId }
    )
    await waitForTabRegistration(browserPageId)
  }

  // Automation may bypass Electron navigation events; publish authoritative URL/title updates.
  notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {}
  }

  // Scope --focus to its worktree so parallel agents cannot move each other's view.
  notifyRendererBrowserPaneFocus(worktreeId: string | undefined, browserPageId: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:pane-focus', {
        worktreeId: worktreeId ?? null,
        browserPageId
      })
    } catch {}
  }

  async browserSnapshot(params: BrowserCommandTargetParams): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(target.worktreeId, target.browserPageId)
  }
}
