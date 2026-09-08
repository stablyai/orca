import { describe, expect, it } from 'vitest'
import type { MobileWebSessionSnapshotResult } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebSessionTabPresentation } from './mobile-web-session-tab-presentation'

describe('mobile web session tab presentation', () => {
  it('rebuilds the existing file-tab view model without an absolute host path', () => {
    const snapshot: MobileWebSessionSnapshotResult = {
      workspaceId: 'workspace_opaque',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      workspaceTransportState: 'unavailable',
      activeTabId: 'file-1',
      activeTabType: 'file',
      truncated: false,
      tabs: [
        {
          type: 'file',
          id: 'file-1',
          title: 'app.ts',
          relativePath: 'src/app.ts',
          language: 'plaintext',
          mode: 'edit',
          isActive: true
        }
      ]
    }

    const presentation = mobileWebSessionTabPresentation(snapshot)
    expect(presentation.workspaceTransportState).toBe('unavailable')
    expect(presentation.tabs).toEqual([
      {
        type: 'file',
        id: 'file-1',
        title: 'app.ts',
        filePath: 'mobile-web-tab:file-1',
        relativePath: 'src/app.ts',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isActive: true
      }
    ])
  })

  it('rebuilds browser tabs from opaque page state without replacing the existing pane model', () => {
    const browserPageId = `browser_0_${'01'.repeat(16)}`
    const snapshot: MobileWebSessionSnapshotResult = {
      workspaceId: 'workspace_opaque',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 3,
      activeTabId: browserPageId,
      activeTabType: 'browser',
      truncated: false,
      tabs: [
        {
          type: 'browser',
          id: browserPageId,
          browserPageId,
          title: 'Example',
          url: 'https://example.com/',
          loading: false,
          canGoBack: true,
          canGoForward: false,
          isActive: true
        }
      ]
    }

    expect(mobileWebSessionTabPresentation(snapshot).tabs).toEqual([
      {
        type: 'browser',
        id: browserPageId,
        browserPageId,
        browserWorkspaceId: browserPageId,
        title: 'Example',
        url: 'https://example.com/',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        isActive: true
      }
    ])
  })
})
