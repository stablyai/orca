import { expect, it } from 'vitest'
import { setRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import {
  setupLayoutOwnerRuntime,
  WORKTREE_ID
} from '../layout/orca-runtime-layout-owner-start-fixture'

it('publishes a rename and reset for a live terminal the open host window holds no pane for', async () => {
  const { runtime } = setupLayoutOwnerRuntime()
  setRuntimeDesktopSurface({
    showNotification: () => false,
    hasWindow: () => true,
    hasLiveRenderer: () => true,
    sendToWindow: () => true,
    requestRenderer: () => Promise.reject(new Error('unexpected renderer request'))
  })
  const tabId = '11111111-1111-4111-8111-111111111111'
  const leafId = '22222222-2222-4222-8222-222222222222'
  const handle = 'term_paired_title'
  const ptyId = 'pty-paired-title'
  const rowId = `${tabId}::${leafId}`
  runtime.attachWindow(1)
  runtime.registerPty(ptyId, WORKTREE_ID, null, { tabId, leafId, terminalHandle: handle })
  try {
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'paired-title',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: rowId,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: rowId,
              parentTabId: tabId,
              leafId,
              ptyId,
              title: 'Terminal',
              customTitle: 'Original title',
              isActive: true
            }
          ]
        }
      ]
    })
    const published = async () => {
      const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      const tab = result.tabs.find((entry) => entry.id === rowId)
      return {
        customTitle: tab?.type === 'terminal' ? tab.customTitle : undefined,
        publicationEpoch: result.publicationEpoch
      }
    }

    expect(await published()).toEqual({
      customTitle: 'Original title',
      publicationEpoch: 'paired-title'
    })
    await runtime.renameTerminal(handle, ' Paired title ')
    // The window stays the publisher; a headless epoch would retire its later frames.
    expect(await published()).toEqual({
      customTitle: 'Paired title',
      publicationEpoch: 'paired-title'
    })
    await runtime.renameTerminal(handle, '   ')
    expect((await published()).customTitle).toBeNull()
  } finally {
    await runtime.onPtyExit(ptyId, 0)
    setRuntimeDesktopSurface(null)
  }
})
