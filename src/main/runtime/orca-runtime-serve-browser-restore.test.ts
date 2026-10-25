import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { withOpenedServeBrowserTab } from './serve-browser-tab-layout'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { BLANK_BROWSER_TAB_STATE } from '../../shared/workspace-layout/workspace-layout-beside'

const BROWSER_ONLY_WORKTREE_ID = 'repo-1::/tmp/browser-only'

/** A host with no window whose saved session holds browser tabs from a run before a restart. */
function restartedServe(session: WorkspaceSessionState = savedServeTabs()) {
  const saved = session
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => ['local'] })
  const runtime = new OrcaRuntimeService(runtimeStore)
  const livePages: string[] = []
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => {
    livePages.push(browserPageId!)
    return { browserPageId: browserPageId! }
  })
  const registered = () => new Map(livePages.map((pageId, index) => [pageId, index + 1]))
  runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn(async () => {}) })
  runtime.setAgentBrowserBridge(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only tabList from the bridge on these paths.
    {
      tabList: vi.fn(() => ({
        tabs: livePages.map((browserPageId, index) => ({
          browserPageId,
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
  return { runtime, createTab, getSession }
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
  // The tab a window last showed, as it records it.
  return {
    ...session,
    activeBrowserTabIdByWorktree: {
      ...session.activeBrowserTabIdByWorktree,
      [TEST_WORKTREE_ID]: 'page-2'
    }
  }
}

/** A tab a window saved: its tab, page and unified tab each have their own id. */
function desktopSavedTab(): WorkspaceSessionState {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  const state = { ...BLANK_BROWSER_TAB_STATE, url: 'https://example.com/', title: 'Example' }
  return {
    ...session,
    browserTabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          ...state,
          id: 'tab-desk',
          worktreeId: TEST_WORKTREE_ID,
          activePageId: 'page-desk',
          pageIds: ['page-desk'],
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'tab-desk': [
        {
          ...state,
          id: 'page-desk',
          workspaceId: 'tab-desk',
          worktreeId: TEST_WORKTREE_ID,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        ...(session.unifiedTabs?.[TEST_WORKTREE_ID] ?? []),
        {
          id: 'unified-desk',
          entityId: 'tab-desk',
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'browser',
          label: 'Example',
          customLabel: null,
          color: '#3b82f6',
          isPinned: true,
          sortOrder: 9,
          createdAt: 1
        }
      ]
    }
  }
}

describe('a saved browser tab on a host with no window', () => {
  it('is listed after a restart without starting its page', async () => {
    const { runtime, createTab } = restartedServe()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs.find((tab) => tab.type === 'browser')).toMatchObject({
      id: 'page-1',
      browserPageId: 'page-1',
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('starts its page once, at its saved address, when a client opens it', async () => {
    const { runtime, createTab } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await Promise.all([
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1'),
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')
    ])

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-1',
        url: 'https://example.com/',
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('is forgotten when a client closes it', async () => {
    const { runtime, getSession } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')

    const saved = getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []
    expect(saved.map((tab) => tab.id)).toEqual(['page-2'])
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.some((tab) => tab.id === 'page-1')).toBe(false)
  })

  it('is saved, without becoming the recorded active tab, when a client creates it', async () => {
    const { runtime, getSession } = restartedServe(makeWorkspaceSessionWithHeadlessTerminal())

    await runtime.browserTabCreate({
      worktree: `id:${TEST_WORKTREE_ID}`,
      url: 'https://example.com/new',
      page: 'page-new'
    })

    // A switch-on build saves the page once main's layout write lands.
    await vi.waitFor(() => {
      const saved = getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []
      expect(saved.map((tab) => [tab.id, tab.url])).toEqual([
        ['page-new', 'https://example.com/new']
      ])
    })
    // Which tab shows is a view's choice; opening one records none.
    expect(getSession().activeBrowserTabIdByWorktree?.[TEST_WORKTREE_ID]).toBeUndefined()
  })

  it('keeps its saved title when its page is restored', async () => {
    const { runtime, createTab, getSession } = restartedServe()

    await runtime['serveBrowserTabs'].start(TEST_WORKTREE_ID, 'page-1')

    expect(createTab).toHaveBeenCalledTimes(1)
    const saved = getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []
    expect(saved.map((tab) => [tab.id, tab.title])).toEqual([
      ['page-1', 'Example'],
      ['page-2', 'Example']
    ])
  })
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
    // What a restart reads back.
    const restarted = restartedServe(getSession())
    const listed = await restarted.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.some((tab) => tab.id === 'page-1')).toBe(false)
  })

  it('starts its page for a command that names only the page', async () => {
    const { runtime, createTab } = restartedServe()

    expect(await runtime['serveBrowserTabs'].start(undefined, 'page-1')).toBe(true)

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-1', worktreeId: TEST_WORKTREE_ID })
    )
  })

  it('starts the active saved tab for a tab list or a pageless command, as a window mounts it', async () => {
    const { runtime, createTab } = restartedServe()

    const listed = await runtime.browserTabList({ worktree: `id:${TEST_WORKTREE_ID}` })
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` })

    // The last tab opened is the one the layout shows, as a window shows it.
    expect(listed.tabs.map((tab) => tab.browserPageId)).toEqual(['page-2'])
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-2' }))
  })
  it('starts the first saved tab when the layout records none, as a window does', async () => {
    const saved = savedServeTabs()
    const { runtime, createTab } = restartedServe({ ...saved, activeBrowserTabIdByWorktree: {} })

    const current = await runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(current.tab.browserPageId).toBe('page-1')
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-1' }))
  })

  it('falls back to the first saved tab once the active one is closed', async () => {
    const { runtime, createTab, getSession } = restartedServe()

    await runtime.browserTabClose({ worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-2' })
    expect(getSession().activeBrowserTabIdByWorktree?.[TEST_WORKTREE_ID]).toBe('page-2')

    const current = await runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(current.tab.browserPageId).toBe('page-1')
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-1' }))
  })

  it('starts the first tab this host can show when the active one is a desktop document page', async () => {
    const saved = savedServeTabs()
    const docLocation = {
      kind: 'workspace-doc' as const,
      worktreeId: TEST_WORKTREE_ID,
      filePath: 'a.md'
    }
    const { runtime, createTab } = restartedServe({
      ...saved,
      browserPagesByWorkspace: Object.fromEntries(
        Object.entries(saved.browserPagesByWorkspace ?? {}).map(([tabId, pages]) => [
          tabId,
          pages.map((page) => (page.id === 'page-2' ? { ...page, docLocation } : page))
        ])
      )
    })

    const current = await runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(current.tab.browserPageId).toBe('page-1')
    await runtime.browserSnapshot({ worktree: `id:${TEST_WORKTREE_ID}` })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-1' }))
  })

  it('reports no browser tab only when the worktree saves none', async () => {
    const { runtime, createTab } = restartedServe(makeWorkspaceSessionWithHeadlessTerminal())

    await expect(runtime.browserTabCurrent({ worktree: `id:${TEST_WORKTREE_ID}` })).rejects.toThrow(
      'No browser tab open in this worktree'
    )
    expect(createTab).not.toHaveBeenCalled()
  })

  it('reports no tab when no worktree is named and no page runs, as a window does', async () => {
    const { runtime, createTab } = restartedServe()

    await expect(runtime.browserTabCurrent({})).rejects.toThrow('No browser tab open')
    expect(createTab).not.toHaveBeenCalled()
  })
  it('saves a re-created page whose id the layout still records as active', () => {
    const session = {
      ...makeWorkspaceSessionWithHeadlessTerminal(),
      activeBrowserTabIdByWorktree: { [TEST_WORKTREE_ID]: 'page-9' }
    }

    const next = withOpenedServeBrowserTab('local', session, {
      worktreeId: TEST_WORKTREE_ID,
      pageId: 'page-9',
      url: 'https://example.com/',
      title: 'Example'
    })

    expect(next?.browserTabsByWorktree?.[TEST_WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'page-9'
    ])
  })

  it('starts the named page for a tab switch', async () => {
    const { runtime, createTab } = restartedServe()

    const switched = await runtime.browserTabSwitch({
      worktree: `id:${TEST_WORKTREE_ID}`,
      page: 'page-2'
    })

    expect(switched.browserPageId).toBe('page-2')
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-2' }))
  })

  // A paired desktop probes a handle-less tab with tabShow; that must wake this page, not a new one.
  it('starts the named saved page once for a tab show after a restart', async () => {
    const { runtime, createTab } = restartedServe()

    const shown = await runtime.browserTabShow({
      worktree: `id:${TEST_WORKTREE_ID}`,
      page: 'page-1'
    })

    expect(shown.tab.browserPageId).toBe('page-1')
    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ browserPageId: 'page-1' }))
  })

  it('is found by page alone in a workspace that holds only browser tabs', async () => {
    const { runtime, createTab } = restartedServe()

    expect(await runtime['serveBrowserTabs'].start(undefined, 'page-3')).toBe(true)

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-3', worktreeId: BROWSER_ONLY_WORKTREE_ID })
    )
  })

  it("keeps a window-saved tab's pin and colour once its page starts", async () => {
    const { runtime } = restartedServe(desktopSavedTab())
    const browserRow = async () =>
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.find(
        (tab) => tab.type === 'browser'
      )
    expect(await browserRow()).toMatchObject({ color: '#3b82f6', isPinned: true })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-desk')

    expect(await browserRow()).toMatchObject({
      browserPageId: 'page-desk',
      color: '#3b82f6',
      isPinned: true
    })
  })
})
