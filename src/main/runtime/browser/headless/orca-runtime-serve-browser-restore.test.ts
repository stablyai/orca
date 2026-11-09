import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { withOpenedServeBrowserTab } from './serve-browser-tab-layout'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

const BROWSER_ONLY_WORKTREE_ID = 'repo-1::/tmp/browser-only'

function restartedServe(session: WorkspaceSessionState = savedServeTabs()) {
  const saved = session
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => ['local'] })
  const runtime = new OrcaRuntimeService(runtimeStore)
  let profileId = 'default'
  const livePages: string[] = []
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => {
    livePages.push(browserPageId!)
    return { browserPageId: browserPageId! }
  })
  const registered = () => new Map(livePages.map((pageId, index) => [pageId, index + 1]))
  runtime.setOffscreenBrowserBackend({
    createTab,
    closeTab: vi.fn(async () => {}),
    ownsTab: () => true
  })
  runtime.setAgentBrowserBridge(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only tabList from the bridge on these paths.
    {
      tabList: vi.fn(() => ({
        tabs: livePages.map((browserPageId, index) => ({
          browserPageId,
          profileId,
          index,
          url: 'https://example.com/',
          title: 'Example',
          active: false
        }))
      })),
      getRegisteredTabs: vi.fn(() => registered()),
      snapshot: vi.fn(async () => ({ snapshot: '' })),
      getActivePageId: vi.fn(() => livePages[0] ?? null),
      setActiveTab: vi.fn(),
      tabSwitch: vi.fn(async (_index: unknown, _worktreeId: unknown, browserPageId: string) => ({
        switched: livePages.indexOf(browserPageId),
        browserPageId
      }))
    } as never
  )
  return {
    runtime,
    createTab,
    getSession,
    setProfileId: (id: string) => {
      profileId = id
    }
  }
}

function savedServeTabs(): WorkspaceSessionState {
  let session = makeWorkspaceSessionWithHeadlessTerminal()
  for (const [worktreeId, pageId] of [
    [TEST_WORKTREE_ID, 'page-1'],
    [TEST_WORKTREE_ID, 'page-2'],
    [BROWSER_ONLY_WORKTREE_ID, 'page-3']
  ] as const) {
    session = withOpenedServeBrowserTab('local', session, {
      worktreeId,
      pageId,
      url: 'https://example.com/',
      title: 'Example'
    })!
  }
  return {
    ...session,
    activeBrowserTabIdByWorktree: {
      ...session.activeBrowserTabIdByWorktree,
      [TEST_WORKTREE_ID]: 'page-2'
    }
  }
}

describe('a saved browser tab on a host with no window', () => {
  it('stays closed when its page reports a navigation after the close', async () => {
    const { runtime, getSession } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')
    runtime.serveBrowserPageNavigated({
      worktreeId: TEST_WORKTREE_ID,
      pageId: 'page-1',
      url: 'https://example.com/late',
      title: 'Late'
    })

    const saved = getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []
    expect(saved.map((tab) => tab.id)).toEqual(['page-2'])
    const restarted = restartedServe(getSession())
    const listed = await restarted.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.some((tab) => tab.id === 'page-1')).toBe(false)
  })
})
