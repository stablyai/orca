import { describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { holdScreencastWindowHost } from '../../browser/screencast/browser-screencast-window-host'
import {
  followOpenedRendererLinkTabForClient,
  returnClientToPopupOpener
} from './server-page-client-popup-follow'

function makeSnapshot(
  pageIds: string[]
): RuntimeMobileSessionTabsResult & RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: pageIds[0] ?? null,
    activeTabType: 'browser',
    tabs: pageIds.map((id, idx) => ({
      type: 'browser' as const,
      id: `tab-${id}`,
      title: id,
      browserWorkspaceId: id,
      browserPageId: id,
      url: `https://example.com/${id}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      isActive: idx === 0
    }))
  }
}

describe('server-page-client-popup-follow', () => {
  it('returns a paired client viewing a closed popup to its immediate or fallback opener', async () => {
    const applyTabNavigation = vi.fn()
    await returnClientToPopupOpener(
      {
        getActiveTabId: () => 'popup-2',
        getMobileSessionTabsForWorktree: async () => makeSnapshot(['root-1']),
        applyTabNavigation
      },
      {
        worktreeId: 'wt-1',
        browserPageId: 'popup-2',
        openerBrowserPageId: 'popup-1',
        fallbackOpenerBrowserPageId: 'root-1',
        pairedDeviceId: 'phone-1'
      }
    )
    expect(applyTabNavigation).toHaveBeenCalledWith(
      expect.anything(),
      'tab-root-1',
      'caller',
      'phone-1',
      true
    )
  })

  it('leaves a paired client alone if it already navigated away from the popup', async () => {
    const applyTabNavigation = vi.fn()
    await returnClientToPopupOpener(
      {
        getActiveTabId: () => 'terminal-1',
        getMobileSessionTabsForWorktree: async () => makeSnapshot(['root-1']),
        applyTabNavigation
      },
      {
        worktreeId: 'wt-1',
        browserPageId: 'popup-1',
        openerBrowserPageId: 'root-1',
        pairedDeviceId: 'phone-1'
      }
    )
    expect(applyTabNavigation).not.toHaveBeenCalled()
  })

  it('waits for a newly synced renderer target="_blank" tab and follows it on the paired client', async () => {
    const callbacks: (() => void)[] = []
    let stored = makeSnapshot(['root-1'])
    const applyTabNavigation = vi.fn()

    const pending = followOpenedRendererLinkTabForClient(
      {
        getStoredSnapshot: () => stored,
        graphSyncCallbacks: callbacks,
        getMobileSessionTabsForWorktree: async () => stored!,
        applyTabNavigation
      },
      { worktreeId: 'wt-1', url: 'https://example.com/new-tab', pairedDeviceId: 'phone-1' }
    )

    stored = makeSnapshot(['root-1', 'new-tab'])
    for (const cb of callbacks.slice()) {
      cb()
    }
    await pending

    expect(applyTabNavigation).toHaveBeenCalledWith(
      expect.anything(),
      'tab-new-tab',
      'caller',
      'phone-1',
      true
    )
    expect(callbacks).toHaveLength(0)
  })

  it('holds stayHidden capturer count while streaming a hidden native popup window', () => {
    const incrementCapturerCount = vi.fn()
    const decrementCapturerCount = vi.fn()
    const hold = holdScreencastWindowHost(
      {
        getType: () => 'window',
        isOffscreen: () => false,
        isDestroyed: () => false,
        incrementCapturerCount,
        decrementCapturerCount
      },
      { getAvailableAuthoritativeWindowId: () => 1 },
      () => {}
    )
    expect(incrementCapturerCount).toHaveBeenCalledWith(undefined, true)
    hold.release()
    hold.release()
    expect(decrementCapturerCount).toHaveBeenCalledTimes(1)
    expect(decrementCapturerCount).toHaveBeenCalledWith(true)
  })
})
