import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

// A workspace on a server this desktop is a client of: absent from the desktop's own store.
const SERVER_WORKTREE_ID = 'server-repo::/srv/repo'

describe("a desktop's own tabs in a server workspace", () => {
  it('lists them for the phone with the whole desktop order beside them', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: SERVER_WORKTREE_ID,
          publicationEpoch: 'renderer:desktop',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'editor-tab',
          activeTabType: 'file',
          tabGroups: [
            {
              id: 'group-1',
              activeTabId: 'editor-tab',
              tabOrder: ['editor-tab'],
              desktopTabOrder: ['host-terminal', 'editor-tab', 'host-page']
            }
          ],
          tabs: [
            {
              type: 'file',
              id: 'editor-tab',
              title: 'a.ts',
              filePath: '/srv/repo/a.ts',
              relativePath: 'a.ts',
              language: 'typescript',
              mode: 'edit',
              isDirty: false,
              isActive: true
            }
          ]
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${SERVER_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([expect.objectContaining({ type: 'file', id: 'editor-tab' })])
    expect(listed.tabGroups).toEqual([
      expect.objectContaining({
        tabOrder: ['editor-tab'],
        desktopTabOrder: ['host-terminal', 'editor-tab', 'host-page']
      })
    ])
  })
})
