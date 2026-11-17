import { describe, expect, it, vi } from 'vitest'
import '../../terminal/layout/bind-first-pane.test-fixture'
import '../../../../shared/workspace-layout/layout-owner-switch'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { MOCK_GIT_WORKTREES, electronMocks } from '../../orca-runtime-test-mocks/setup.spec'
import '../../orca-runtime'
import { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'

import '../../../git/worktrees/removal/worktree-removal-preflight'
import 'electron'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import '../../../git/worktrees/removal/worktree-removal'
import {
  TEST_REPO_ID,
  createRuntime
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

function createBrowserBridge(overrides: Partial<AgentBrowserBridge>): AgentBrowserBridge {
  return Object.assign(vi.mockObject(AgentBrowserBridge.prototype), overrides)
}

describe('OrcaRuntimeService', () => {
  describe('browser page targeting', () => {
    function mockLiveBrowserGuest(): void {
      electronMocks.webContents.fromId.mockReturnValue({
        isDestroyed: () => false,
        isLoading: () => false,
        isLoadingMainFrame: () => false
      })
    }

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn<AgentBrowserBridge['snapshot']>()

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          snapshot: snapshotMock,
          getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
          getRegisteredPageWebContentsId: (page: string) => (page === 'page-1' ? 1 : undefined)
        })
      )

      await expect(
        runtime.browserSnapshot({
          worktree: 'path:/tmp/missing-worktree',
          page: 'page-1'
        })
      ).rejects.toThrow('selector_not_found')
      expect(snapshotMock).not.toHaveBeenCalled()
    })

    it('does not silently drop invalid explicit worktree selectors for non-page browser commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const tabListMock = vi.fn<AgentBrowserBridge['tabList']>()

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          tabList: tabListMock
        })
      )

      await expect(
        runtime.browserTabList({
          worktree: 'path:/tmp/missing-worktree'
        })
      ).rejects.toThrow('selector_not_found')
      expect(tabListMock).not.toHaveBeenCalled()
    })

    it('rejects closing an unknown page id instead of treating it as success', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
          getRegisteredPageWebContentsId: (page: string) => (page === 'page-1' ? 1 : undefined)
        })
      )

      await expect(
        runtime.browserTabClose({
          page: 'missing-page'
        })
      ).rejects.toThrow('Browser page missing-page was not found')
    })

    it('rejects closing a page outside the explicitly scoped worktree', async () => {
      mockLiveBrowserGuest()
      vi.mocked(listWorktrees).mockResolvedValue([
        ...MOCK_GIT_WORKTREES,
        {
          path: '/tmp/worktree-b',
          head: 'def',
          branch: 'feature/bar',
          isBare: false,
          isMainWorktree: false
        }
      ])
      const runtime = createRuntime()
      const getRegisteredTabsMock = vi.fn((worktreeId?: string) =>
        worktreeId === `${TEST_REPO_ID}::/tmp/worktree-b` ? new Map() : new Map([['page-1', 1]])
      )

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          getRegisteredTabs: getRegisteredTabsMock,
          getRegisteredPageWebContentsId: (page: string, worktreeId?: string) =>
            getRegisteredTabsMock(worktreeId).get(page)
        })
      )

      await expect(
        runtime.browserTabClose({
          page: 'page-1',
          worktree: 'path:/tmp/worktree-b'
        })
      ).rejects.toThrow('Browser page page-1 was not found in this worktree')
      expect(getRegisteredTabsMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/tmp/worktree-b`)
    })
  })
})
