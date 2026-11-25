import { describe, expect, it } from 'vitest'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'

const desktopPage = {
  type: 'browser' as const,
  id: 'page-tab',
  title: 'Example',
  browserWorkspaceId: 'workspace',
  browserPageId: 'page-1',
  placement: {
    kind: 'client' as const,
    browserHostClientId: 'desktop-client',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  },
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

const snapshot = {
  worktree: 'wt',
  publicationEpoch: 'epoch',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: 'page-tab',
  activeTabType: 'browser' as const,
  tabs: [desktopPage]
}

const hosts = {
  describeClientHostedBrowserPage: (browserPageId: string) =>
    browserPageId === 'page-1'
      ? {
          browserPageId,
          worktreeId: 'wt',
          url: desktopPage.url,
          title: desktopPage.title,
          loading: false,
          browserHostClientId: 'desktop-client',
          hostDeviceName: 'Studio Mac',
          hostAbsent: true
        }
      : undefined
}

describe('projectSessionTabBrowserPlacements', () => {
  it('hides a desktop-drawn page only from clients that would try to stream it', () => {
    expect(projectSessionTabBrowserPlacements(snapshot, [], hosts).tabs).toEqual([])
    expect(
      projectSessionTabBrowserPlacements(snapshot, ['browser.clientHost.rows.v1'], hosts).tabs
    ).toEqual([{ ...desktopPage, clientHost: { deviceName: 'Studio Mac', offline: true } }])
    expect(
      projectSessionTabBrowserPlacements(
        snapshot,
        ['browser.clientHost.v1', 'browser.clientHost.rows.v1'],
        hosts
      )
    ).toBe(snapshot)
  })
})
