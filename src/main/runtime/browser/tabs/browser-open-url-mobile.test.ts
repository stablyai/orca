import { describe, expect, it } from 'vitest'
import {
  activeMobileViewerClientIdsForPane,
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
})
