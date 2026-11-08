import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'

import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'

import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'

import { TEST_WORKTREE_ID, store } from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'

import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'

it('drops renderer browser rows once the serve desktop window closes', async () => {
  const runtime = new OrcaRuntimeService(store)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mocks partial OffscreenBrowserBackend.
  runtime.setOffscreenBrowserBackend({ closeTab: vi.fn(), ownsTab: () => true } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mocks partial AgentBrowserBridge.
  runtime.setAgentBrowserBridge({ tabList: () => ({ tabs: [] }) } as never)
  electronMocks.BrowserWindow.fromId.mockImplementation((id: number) =>
    id === 1 ? { isDestroyed: () => false } : null
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'browser-unified-1',
        activeTabType: 'browser',
        tabs: [
          {
            type: 'browser',
            id: 'browser-unified-1',
            title: 'Browser',
            browserWorkspaceId: 'browser-workspace-1',
            browserPageId: 'browser-page-1',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ]
      }
    ]
  })
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  expect(listed.tabs).toEqual([expect.objectContaining({ id: 'browser-unified-1' })])

  const pushed: RuntimeMobileSessionTabsSnapshot[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    if ('tabs' in snapshot) {
      pushed.push(snapshot)
    }
  })

  runtime.markGraphUnavailable(1)
  await vi.waitFor(() => expect(pushed.at(-1)?.tabs).toEqual([]))
  // Desktop and web mirrors drop same-version frames, so the drop must advance the version.
  expect(pushed.at(-1)?.snapshotVersion).toBeGreaterThan(listed.snapshotVersion)
  expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
})
