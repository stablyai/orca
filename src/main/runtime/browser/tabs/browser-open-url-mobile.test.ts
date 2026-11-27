import { describe, expect, it, vi } from 'vitest'
import {
  activeMobileViewerClientIdsForPane,
  openUrlForMobileOrClient,
  selectTargetMobileNavigationIds
} from './mobile-terminal-browser-open'

describe('mobile terminal open-url targeting', () => {
  it('isolates viewer detection and navigation targets to the phone viewing that pane', () => {
    const leafUuid = '11111111-1111-4111-8111-111111111111'
    const siblingLeafUuid = '22222222-2222-4222-8222-222222222222'
    const viewers = activeMobileViewerClientIdsForPane(
      {
        getLeafPtyId: () => 'pty-1',
        getPanePtyId: () => 'pty-1',
        getDisplayMode: () => 'desktop',
        getDriverKind: () => 'idle',
        getSubscribers: () => [{ clientId: 'opaque-device-token', viewport: { cols: 80 } }],
        getMobileListenerIds: () => ['phone-1', 'phone-2'],
        getClientActiveTabId: (clientId) =>
          clientId === 'phone-1' ? 'term-leaf-1' : 'term-leaf-2',
        getMobileSessionSnapshot: () => ({
          worktree: 'wt-1',
          publicationEpoch: 'e1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'term-leaf-1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'term-leaf-1',
              parentTabId: 'tab-1',
              leafId: leafUuid,
              title: 'zsh',
              ptyId: 'pty-1',
              isActive: true
            },
            {
              type: 'terminal',
              id: 'term-leaf-2',
              parentTabId: 'tab-1',
              leafId: siblingLeafUuid,
              title: 'zsh',
              ptyId: 'pty-2',
              isActive: false
            }
          ]
        })
      },
      `tab-1:${leafUuid}`,
      'wt-1'
    )
    expect(viewers).toEqual(['phone-1'])
    expect(selectTargetMobileNavigationIds(['phone-1', 'phone-2'], viewers)).toEqual(['phone-1'])
    // Unmatched subscriber ids must never broadcast to other paired phones.
    expect(
      selectTargetMobileNavigationIds(['phone-1', 'phone-2'], ['opaque-device-token'])
    ).toEqual([])
  })

  it('aborts and cleans up a late-created server tab when onlyWhenMobileViewing hits its deadline', async () => {
    let resolveCreate!: (value: { browserPageId: string }) => void
    const followBrowserTabOnMobile = vi.fn(async () => true)
    const closeServerTab = vi.fn(async () => {})
    const result = await openUrlForMobileOrClient({
      host: {
        getAgentBrowserBridge: () => null,
        resolveBrowserWorkspace: async () => ({ id: 'wt-1' }),
        resolveBrowserNetworkExecutionHost: () => {
          throw new Error('unexpected')
        },
        hasMobileTerminalViewer: () => true,
        followBrowserTabOnMobile,
        getBrowserHostLeaseRegistry: () => {
          throw new Error('unexpected')
        },
        getBrowserHostRequestRegistry: () => {
          throw new Error('unexpected')
        },
        getPairedDeviceName: () => null,
        getRuntimeBrowserPageRegistry: () => {
          throw new Error('unexpected')
        },
        notifyHeadlessBrowserSessionTabsChanged: () => {}
      },
      params: {
        url: 'https://auth.example.com/login',
        worktree: 'id:wt-1',
        paneKey: 'tab-1:leaf-1',
        onlyWhenMobileViewing: true
      },
      createServerTab: () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
      closeServerTab,
      mobileOpenDeadlineMs: 10
    })
    expect(result).toEqual({ browserPageId: null })
    expect(followBrowserTabOnMobile).not.toHaveBeenCalled()

    resolveCreate({ browserPageId: 'page-late' })
    await Promise.resolve()
    await Promise.resolve()
    expect(closeServerTab).toHaveBeenCalledWith('page-late', 'id:wt-1')
  })
})
