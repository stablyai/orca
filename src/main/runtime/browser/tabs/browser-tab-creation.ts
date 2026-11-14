import { createBrowserTabInRenderer } from './browser-tab-renderer-create'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { BrowserPageCreationPlacement } from '../../../../shared/browser/client-hosting/browser-client-host-placement'
import type { BrowserTabSplitDirection } from '../../../../shared/browser-tab-split-direction'
import {
  publishCreatedBrowserSessionTab,
  resolveBrowserTabCreateFocus,
  type BrowserTabCreateFocusResolution
} from './browser-tab-create-publication'
import { browserSessionRegistry } from '../../../browser/sessions/profiles/browser-session-registry'
import { BrowserError } from '../../../browser/browser-error'
import { waitForTabRegistration } from '../../../ipc/browser/browser-tab-registration-wait'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from '../commands/browser-command-targets'
import {
  createBrowserClientPage,
  createBrowserPageOnPairedHost,
  openBrowserUrlOnClient
} from '../client-pages/browser-client-page-opening'
import { opensOnPairedDesktop } from '../client-pages/server-agent-tab-placement'

type BrowserTabCreateRequest = {
  url?: string
  worktree?: string
  page?: string
  profileId?: string
  waitForRegistration?: boolean
  activate?: boolean
  navigation?: RuntimeNavigationTarget
  targetGroupId?: string
  placement?: BrowserPageCreationPlacement
  split?: BrowserTabSplitDirection
  splitFromTabId?: string
}

type BrowserTabCreateCaller = {
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  opensPageLink?: boolean
  signal?: AbortSignal
}

export class RuntimeBrowserTabCreation {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAgentBrowserBridge'
      | 'resolveBrowserWorkspace'
      | 'resolveBrowserNetworkExecutionHost'
      | 'getBrowserHostLeaseRegistry'
      | 'getBrowserHostRequestRegistry'
      | 'getPairedDeviceName'
      | 'getRuntimeBrowserPageRegistry'
      | 'getAvailableAuthoritativeWindow'
      | 'getOffscreenBrowserBackend'
      | 'getAuthoritativeWindow'
      | 'markHeadlessBrowserSessionTabActive'
      | 'notifyHeadlessBrowserSessionTabsChanged'
      | 'serveBrowserTabs'
    >,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'notifyRendererNavigation'
    >
  ) {}

  async browserTabCreate(
    params: BrowserTabCreateRequest,
    caller?: BrowserTabCreateCaller
  ): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const focus = resolveBrowserTabCreateFocus({
      activate: params.activate,
      navigation: params.navigation,
      clientKind: caller?.clientKind
    })
    // #21353: every placement must accept folder workspaces.
    const worktree = params.worktree
      ? await this.host.resolveBrowserWorkspace(params.worktree)
      : undefined
    const worktreeId = worktree?.id
    const sessionPartition = browserSessionRegistry.resolveKnownPartition(params.profileId)
    if (!sessionPartition) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    // Why reject rather than ignore: a caller asking for a split pane should learn it got none.
    if (
      params.split &&
      (params.placement?.kind === 'client' || !this.host.getAvailableAuthoritativeWindow())
    ) {
      throw new BrowserError(
        'invalid_argument',
        'Opening a browser tab in a split pane needs an Orca desktop window on this host.'
      )
    }
    if (params.placement?.kind === 'client') {
      return createBrowserClientPage(
        this.host,
        { ...params, placement: params.placement },
        {
          worktree,
          browserProfileId: params.profileId ?? browserSessionRegistry.getDefaultProfile().id,
          caller
        }
      )
    }
    // Headless hosts use offscreen WebContents because no renderer webview exists.
    if (!this.host.getAvailableAuthoritativeWindow()) {
      const offscreen = this.host.getOffscreenBrowserBackend()
      const createOffscreen = async (): Promise<{ browserPageId: string }> => {
        if (!offscreen) {
          throw new BrowserError('browser_error', 'This host does not support browser panes.')
        }
        return this.createOffscreenTab(offscreen, params, caller, url, worktreeId, focus)
      }
      // A desktop on "Server (streamed)" declines when asked, so agent tabs keep streaming from here.
      if (opensOnPairedDesktop(this.host, params, caller, offscreen !== null)) {
        return createBrowserPageOnPairedHost(
          this.host,
          params,
          params.profileId ?? browserSessionRegistry.getDefaultProfile().id,
          offscreen ? createOffscreen : undefined,
          caller?.signal
        )
      }
      return createOffscreen()
    }
    const { browserPageId } = await createBrowserTabInRenderer(
      this.host,
      url,
      worktreeId,
      params.profileId,
      params.profileId ? sessionPartition : undefined,
      focus.focusesHost,
      params.page,
      undefined,
      params.split ? { direction: params.split, fromTabId: params.splitFromTabId } : undefined
    )

    // Wait for operability, but retain the created id if mounting times out.
    if (params.waitForRegistration !== false) {
      try {
        await waitForTabRegistration(browserPageId)
      } catch {
        // Later commands report a clear error if the created tab never mounts.
      }
    }

    const bridge = this.targets.requireAgentBrowserBridge()
    publishCreatedBrowserSessionTab(this.host, {
      placementKind: 'renderer',
      browserPageId,
      worktreeId,
      focus,
      ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
      targetGroupId: params.targetGroupId
    })

    // The webview starts at about:blank; bridge navigation preserves registered ownership.
    if (url && url !== 'about:blank') {
      const navigate = async (): Promise<void> => {
        // Nobody reads a new tab's effects, so its first load skips the settle.
        const result = await bridge.goto(url, worktreeId, browserPageId, { reportEffects: false })
        this.targets.notifyRendererNavigation(browserPageId, result.url, result.title)
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
        // Preserve the tab so callers can retry navigation with goto.
      }
    }

    return { browserPageId }
  }

  private async createOffscreenTab(
    offscreen: NonNullable<ReturnType<RuntimeBrowserCommandHost['getOffscreenBrowserBackend']>>,
    params: BrowserTabCreateRequest,
    caller: BrowserTabCreateCaller | undefined,
    url: string,
    worktreeId: string | undefined,
    focus: BrowserTabCreateFocusResolution
  ): Promise<{ browserPageId: string }> {
    const created = await offscreen.createTab({
      url,
      worktreeId,
      profileId: params.profileId,
      ...(params.page ? { browserPageId: params.page } : {})
    })
    if (worktreeId) {
      this.host.serveBrowserTabs?.opened({
        worktreeId,
        pageId: created.browserPageId,
        url,
        title: '',
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.targetGroupId ? { groupId: params.targetGroupId } : {})
      })
    }
    publishCreatedBrowserSessionTab(this.host, {
      placementKind: 'offscreen',
      browserPageId: created.browserPageId,
      worktreeId,
      focus,
      ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
      ...(caller?.opensPageLink ? { opensPageLink: true } : {}),
      targetGroupId: params.targetGroupId
    })
    return { browserPageId: created.browserPageId }
  }

  async browserOpenUrlOnClient(
    params: {
      url: string
      worktree: string
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ browserPageId: string }> {
    return openBrowserUrlOnClient(this.host, params, options?.signal)
  }
}
