// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserSetHeaders } from './runtime-browser-commands-browser-set-headers'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { BrowserPageCreationPlacement } from '../../shared/browser-client-host-placement'
import {
  publishCreatedBrowserSessionTab,
  resolveBrowserTabCreateFocus
} from './browser-tab-create-publication'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { BrowserError } from '../browser/browser-error'
import { randomUUID } from 'node:crypto'
import {
  createRuntimeBrowserClientPage,
  navigateRuntimeBrowserClientPage
} from './runtime-browser-client-page-creation'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import { waitForTabRegistration } from '../ipc/browser-tab-registration-wait'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from './browser-host-capability-selection'

export class RuntimeBrowserCommandsWithBrowserTabCreate extends RuntimeBrowserCommandsWithBrowserSetHeaders {
  async browserTabCreate(
    params: {
      url?: string
      worktree?: string
      page?: string
      profileId?: string
      waitForRegistration?: boolean
      activate?: boolean
      navigation?: RuntimeNavigationTarget
      targetGroupId?: string
      placement?: BrowserPageCreationPlacement
    },
    caller?: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
  ): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const focus = resolveBrowserTabCreateFocus({
      activate: params.activate,
      navigation: params.navigation,
      clientKind: caller?.clientKind
    })
    const worktree = params.worktree
      ? params.placement?.kind === 'client'
        ? await this.host.resolveBrowserWorkspace(params.worktree)
        : await this.host.resolveWorktreeSelector(params.worktree)
      : undefined
    const worktreeId = worktree?.id
    const sessionPartition = browserSessionRegistry.resolveKnownPartition(params.profileId)
    if (!sessionPartition) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    if (params.placement?.kind === 'client') {
      if (!caller?.pairedDeviceId) {
        throw new BrowserError(
          'forbidden',
          'Client-hosted browser pages require an authenticated paired runtime.'
        )
      }
      if (!worktree) {
        throw new BrowserError(
          'invalid_argument',
          'Client-hosted browser pages require an explicit workspace.'
        )
      }
      const browserPageId = params.page ?? randomUUID()
      const executionHost = await this.host.resolveBrowserNetworkExecutionHost(worktree)
      const authority = this.host.getBrowserHostLeaseRegistry()
      const browserProfileId = params.profileId ?? browserSessionRegistry.getDefaultProfile().id
      const created = await createRuntimeBrowserClientPage(authority, {
        browserPageId,
        browserHostClientId: params.placement.browserHostClientId,
        pairedDeviceId: caller.pairedDeviceId,
        browserProfileId,
        executionHost,
        workspaceId: worktree.id
      })
      const pages = this.host.getRuntimeBrowserPageRegistry()
      pages.publishClientPage({
        browserPageId,
        workspaceId: worktree.id,
        browserProfileId,
        executionHostKey: browserNetworkExecutionHostKey(executionHost),
        placement: created.placement,
        pairedDeviceId: caller.pairedDeviceId,
        url: 'about:blank',
        loading: url !== 'about:blank',
        active: focus.startsActive
      })
      publishCreatedBrowserSessionTab(this.host, {
        placementKind: 'client',
        browserPageId,
        worktreeId: worktree.id,
        focus,
        clientNavigationId: caller.pairedDeviceId,
        targetGroupId: params.targetGroupId
      })
      if (url !== 'about:blank') {
        try {
          await navigateRuntimeBrowserClientPage(authority, {
            browserPageId,
            placement: created.placement,
            url
          })
          pages.updatePage(browserPageId, created.placement, { url, loading: false })
        } catch {
          pages.updatePage(browserPageId, created.placement, { loading: false })
        }
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktree.id)
      }
      return { browserPageId }
    }
    // Why: headless serve has no renderer <webview>, so back the page with a main-process offscreen WebContents instead.
    if (!this.host.getAvailableAuthoritativeWindow()) {
      const offscreen = this.host.getOffscreenBrowserBackend()
      if (!offscreen) {
        throw new BrowserError('browser_error', 'This host does not support browser panes.')
      }
      // Why: the offscreen backend registers synchronously, so there is no webview-mount wait.
      const created = await offscreen.createTab({
        url,
        worktreeId,
        profileId: params.profileId,
        ...(params.page ? { browserPageId: params.page } : {})
      })
      publishCreatedBrowserSessionTab(this.host, {
        placementKind: 'offscreen',
        browserPageId: created.browserPageId,
        worktreeId,
        focus,
        ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
        targetGroupId: params.targetGroupId
      })
      return { browserPageId: created.browserPageId }
    }
    const { browserPageId } = await this.createBrowserTabInRenderer(
      url,
      worktreeId,
      params.profileId,
      params.profileId ? sessionPartition : undefined,
      focus.focusesHost,
      params.page
    )

    // Why: the webview must mount and register before the tab is operable, so wait here (returning the ID anyway on timeout).
    if (params.waitForRegistration !== false) {
      try {
        await waitForTabRegistration(browserPageId)
      } catch {
        // Tab exists in the renderer even if the webview hasn't mounted; subsequent commands surface a clear error if it never loads.
      }
    }

    const bridge = this.requireAgentBrowserBridge()
    publishCreatedBrowserSessionTab(this.host, {
      placementKind: 'renderer',
      browserPageId,
      worktreeId,
      focus,
      ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
      targetGroupId: params.targetGroupId
    })

    // Why: the webview loads about:blank first; route navigation through the bridge so its registered owner remains authoritative.
    if (url && url !== 'about:blank') {
      const navigate = async (): Promise<void> => {
        const result = await bridge.goto(url, worktreeId, browserPageId)
        this.notifyRendererNavigation(browserPageId, result.url, result.title)
        if (!this.host.getAvailableAuthoritativeWindow() && worktreeId) {
          this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
        }
      }
      if (params.waitForRegistration === true) {
        void navigate().catch(() => {})
        return { browserPageId }
      }
      try {
        await navigate()
      } catch {
        // Tab exists but navigation failed — caller can retry with explicit goto
      }
    }

    return { browserPageId }
  }

  async browserOpenUrlOnClient(params: {
    url: string
    worktree: string
  }): Promise<{ browserPageId: string }> {
    const protocol = new URL(params.url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new BrowserError('invalid_argument', 'Only http(s) URLs can be opened on the client.')
    }
    const lease = this.host
      .getBrowserHostLeaseRegistry()
      .select(undefined, [
        BROWSER_HOST_WEBVIEW_CAPABILITY,
        BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY
      ])
    return this.browserTabCreate(
      {
        url: params.url,
        worktree: params.worktree,
        activate: true,
        navigation: 'caller',
        placement: { kind: 'client', browserHostClientId: lease.browserHostClientId }
      },
      { pairedDeviceId: lease.pairedDeviceId, clientKind: 'runtime' }
    )
  }
}
