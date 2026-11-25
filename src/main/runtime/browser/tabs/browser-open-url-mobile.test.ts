import { describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'

type CreationHost = ConstructorParameters<typeof RuntimeBrowserTabCreation>[0]
type CreationTargets = ConstructorParameters<typeof RuntimeBrowserTabCreation>[1]

function makeCreation(overrides: {
  hasMobileTerminalViewer?: (paneKey: string, worktreeId?: string) => boolean
  followBrowserTabOnMobile?: (
    worktreeId: string,
    browserPageId: string,
    options?: { paneKey?: string; signal?: AbortSignal }
  ) => Promise<boolean>
}) {
  const createTab = vi.fn().mockResolvedValue({ browserPageId: 'page-mobile-1' })
  const closeServerTab = vi.fn().mockResolvedValue(undefined)
  const followBrowserTabOnMobile =
    overrides.followBrowserTabOnMobile ?? vi.fn().mockResolvedValue(true)
  const host: CreationHost = {
    getAgentBrowserBridge: vi.fn().mockReturnValue(null),
    resolveBrowserWorkspace: vi.fn().mockResolvedValue({ id: 'wt-1' }),
    resolveBrowserNetworkExecutionHost: vi.fn(),
    getBrowserHostLeaseRegistry: vi.fn(),
    getBrowserHostRequestRegistry: vi.fn(),
    getPairedDeviceName: vi.fn(),
    getRuntimeBrowserPageRegistry: vi.fn().mockReturnValue({ yieldSelection: vi.fn() }),
    getAvailableAuthoritativeWindowId: vi.fn().mockReturnValue(null),
    getOffscreenBrowserBackend: vi.fn().mockReturnValue({ createTab }),
    getAuthoritativeWindowId: vi.fn().mockReturnValue(1),
    markHeadlessBrowserSessionTabActive: vi.fn().mockResolvedValue(undefined),
    notifyHeadlessBrowserSessionTabsChanged: vi.fn(),
    hasMobileTerminalViewer: overrides.hasMobileTerminalViewer,
    followBrowserTabOnMobile,
    serveBrowserTabs: undefined
  }
  const targets: CreationTargets = {
    requireAgentBrowserBridge: vi.fn(),
    notifyRendererNavigation: vi.fn()
  }
  return {
    creation: new RuntimeBrowserTabCreation(host, targets, closeServerTab),
    createTab,
    closeServerTab,
    followBrowserTabOnMobile
  }
}

describe('RuntimeBrowserTabCreation.browserOpenUrlOnClient', () => {
  it('opens a server browser tab and follows it on mobile when a mobile viewer is on the pane', async () => {
    const { creation, createTab, followBrowserTabOnMobile } = makeCreation({
      hasMobileTerminalViewer: (paneKey) => paneKey === 'tab-1:leaf-1'
    })

    const result = await creation.browserOpenUrlOnClient({
      url: 'https://auth.example.com/oauth2/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A9615',
      worktree: 'id:wt-1',
      paneKey: 'tab-1:leaf-1',
      onlyWhenMobileViewing: true
    })

    expect(result).toEqual({ browserPageId: 'page-mobile-1' })
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://auth.example.com/oauth2/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A9615',
        worktreeId: 'wt-1'
      })
    )
    expect(followBrowserTabOnMobile).toHaveBeenCalledWith('wt-1', 'page-mobile-1', {
      paneKey: 'tab-1:leaf-1',
      signal: undefined
    })
  })

  it('returns null browserPageId without opening a tab when onlyWhenMobileViewing is true and no mobile viewer is attached', async () => {
    const { creation, createTab, followBrowserTabOnMobile } = makeCreation({
      hasMobileTerminalViewer: () => false
    })

    const result = await creation.browserOpenUrlOnClient({
      url: 'https://example.com',
      worktree: 'id:wt-1',
      paneKey: 'tab-1:leaf-1',
      onlyWhenMobileViewing: true
    })

    expect(result).toEqual({ browserPageId: null })
    expect(createTab).not.toHaveBeenCalled()
    expect(followBrowserTabOnMobile).not.toHaveBeenCalled()
  })

  it('closes the created tab and returns null when mobile follow delivery fails under onlyWhenMobileViewing', async () => {
    const { creation, closeServerTab } = makeCreation({
      hasMobileTerminalViewer: () => true,
      followBrowserTabOnMobile: vi.fn().mockResolvedValue(false)
    })

    const result = await creation.browserOpenUrlOnClient({
      url: 'https://auth.example.com/login',
      worktree: 'id:wt-1',
      paneKey: 'tab-1:leaf-1',
      onlyWhenMobileViewing: true
    })

    expect(result).toEqual({ browserPageId: null })
    expect(closeServerTab).toHaveBeenCalledWith('page-mobile-1', 'id:wt-1')
  })
})
