import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { ServeBrowserTabs } from './serve-browser-tabs'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const WT = 'repo-1::/repo'
const PAGE = { worktreeId: WT, pageId: 'page-1', url: 'https://example.com/', title: 'Example' }

/** A host with no window whose layout writes go through `layout.apply`'s record patch. */
function servedHost(initial: WorkspaceSessionState = getDefaultWorkspaceSession()) {
  let session = initial
  const save = vi.fn((_worktreeId: string, next: WorkspaceSessionState) => {
    session = next
  })
  const applyLayout = vi.fn(
    async (command: LayoutCommand, hostId: ExecutionHostId): Promise<LayoutApplyOutcome> => {
      const change = applyCommandToSession(hostId, session, command)
      session = change.session ?? session
      return change.value
    }
  )
  layoutOwner.isMain = true
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => ({
    browserPageId: browserPageId!
  }))
  const closeRunningPage = vi.fn()
  const tabs = new ServeBrowserTabs({
    backend: () => ({ createTab, closeTab: vi.fn() }),
    livePageIds: () => new Set(),
    savedWorktreeIds: () => [WT],
    session: () => session,
    hostId: () => 'local',
    save,
    applyLayout,
    closeRunningPage
  })
  return { tabs, applyLayout, save, createTab, closeRunningPage, session: () => session }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('served browser tabs in a layout-owner build', () => {
  it('opens a tab through layout.apply, then saves its page so a restart lists it', async () => {
    const host = servedHost()

    host.tabs.opened({ ...PAGE, profileId: 'p1' })
    await settle()

    expect(host.applyLayout).toHaveBeenCalledWith(
      { type: 'openBrowserTab', workspace: WT, pageId: 'page-1', profileId: 'p1' },
      'local'
    )
    expect(host.session().browserTabsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: 'page-1',
        pageIds: ['page-1'],
        sessionProfileId: 'p1',
        url: PAGE.url,
        title: PAGE.title
      })
    ])
    expect(host.session().browserPagesByWorkspace?.['page-1']).toEqual([
      expect.objectContaining({ id: 'page-1', workspaceId: 'page-1', url: PAGE.url })
    ])
    expect(host.tabs.listUnstarted(WT).map((tab) => tab.browserPageId)).toEqual(['page-1'])
  })

  it('does not open a saved page again', async () => {
    const host = servedHost()
    host.tabs.opened(PAGE)
    await settle()

    host.tabs.opened(PAGE)
    await settle()

    expect(host.applyLayout).toHaveBeenCalledTimes(1)
    expect(host.session().browserTabsByWorktree?.[WT]).toHaveLength(1)
  })

  it('closes a tab through layout.apply and drops its page records', async () => {
    const host = servedHost()
    host.tabs.opened(PAGE)
    await settle()

    expect(host.tabs.closed(WT, 'page-1')).toBe(true)
    await settle()

    expect(host.session().browserTabsByWorktree?.[WT] ?? []).toEqual([])
    expect(host.session().unifiedTabs?.[WT] ?? []).toEqual([])
    expect(host.session().browserPagesByWorkspace?.['page-1']).toBeUndefined()
    expect(host.tabs.closed(WT, 'page-1')).toBe(false)
  })

  it('closes a window-saved tab by its own tab-bar entry', async () => {
    const host = servedHost()
    host.tabs.opened(PAGE)
    await settle()
    // As a window saves it: the tab-bar entry has its own id.
    const saved = host.session()
    host.save(WT, {
      ...saved,
      unifiedTabs: {
        [WT]: saved.unifiedTabs![WT]!.map((entry) => ({ ...entry, id: 'unified-1' }))
      },
      tabGroups: {
        [WT]: saved.tabGroups![WT]!.map((group) => ({
          ...group,
          activeTabId: null,
          tabOrder: ['unified-1']
        }))
      }
    })

    host.tabs.closed(WT, 'page-1')
    await settle()

    expect(host.applyLayout).toHaveBeenLastCalledWith(
      { type: 'closeTabs', workspace: WT, tabIds: ['unified-1'], force: true },
      'local'
    )
    expect(host.session().browserTabsByWorktree?.[WT] ?? []).toEqual([])
    expect(host.session().unifiedTabs?.[WT] ?? []).toEqual([])
  })

  it('saves the address a page reached while main was writing its tab', async () => {
    const host = servedHost()

    host.tabs.opened(PAGE)
    host.tabs.navigated({ ...PAGE, url: 'https://example.com/next', title: 'Next' })
    await settle()

    expect(host.session().browserPagesByWorkspace?.['page-1']).toEqual([
      expect.objectContaining({ url: 'https://example.com/next', title: 'Next' })
    ])
    expect(host.session().browserTabsByWorktree?.[WT]?.[0]).toMatchObject({ title: 'Next' })
  })

  it('closes a tab closed while main was writing it, and saves no page for it', async () => {
    const host = servedHost()

    host.tabs.opened(PAGE)
    expect(host.tabs.closed(WT, 'page-1')).toBe(true)
    await settle()

    expect(host.session().browserTabsByWorktree?.[WT] ?? []).toEqual([])
    expect(host.session().browserPagesByWorkspace?.['page-1']).toBeUndefined()
    expect(host.tabs.listUnstarted(WT)).toEqual([])
  })

  it('stops listing a closed tab before main answers', async () => {
    const host = servedHost()
    host.tabs.opened(PAGE)
    await settle()

    host.tabs.closed(WT, 'page-1')

    expect(host.tabs.listUnstarted(WT)).toEqual([])
  })

  it('saves no page when main refuses the open', async () => {
    const host = servedHost()
    host.applyLayout.mockResolvedValueOnce({ ok: false, code: 'invalid_params' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    host.tabs.opened(PAGE)
    await settle()

    expect(host.save).not.toHaveBeenCalled()
    expect(host.closeRunningPage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  describe('a page that joins an existing tab', () => {
    const JOINED = { ...PAGE, pageId: 'page-2', url: 'https://example.com/b', title: 'B' }

    async function hostWithTab() {
      const host = servedHost()
      host.tabs.opened(PAGE)
      await settle()
      return host
    }

    it('adds the page to that tab and saves its record under it', async () => {
      const host = await hostWithTab()

      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      await settle()

      expect(host.applyLayout).toHaveBeenLastCalledWith(
        { type: 'openBrowserPage', workspace: WT, browserTabId: 'page-1', pageId: 'page-2' },
        'local'
      )
      expect(host.session().browserTabsByWorktree?.[WT]).toEqual([
        expect.objectContaining({ id: 'page-1', pageIds: ['page-1', 'page-2'], url: PAGE.url })
      ])
      expect(host.session().browserPagesByWorkspace?.['page-1']).toEqual([
        expect.objectContaining({ id: 'page-1', workspaceId: 'page-1' }),
        expect.objectContaining({ id: 'page-2', workspaceId: 'page-1', url: JOINED.url })
      ])
      expect(host.session().browserPagesByWorkspace?.['page-2']).toBeUndefined()
      expect(host.tabs.unifiedTabId(WT, 'page-2')).toBe('page-1')
    })

    it('opens a new tab when the named tab is not saved', async () => {
      const host = await hostWithTab()

      host.tabs.opened({ ...JOINED, browserTabId: 'gone-tab' })
      await settle()

      expect(host.applyLayout).toHaveBeenLastCalledWith(
        { type: 'openBrowserTab', workspace: WT, pageId: 'page-2' },
        'local'
      )
      expect(host.session().browserTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
        'page-1',
        'page-2'
      ])
    })

    it('closes only that page, keeping the tab and its first page', async () => {
      const host = await hostWithTab()
      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      await settle()

      expect(host.tabs.closed(WT, 'page-2')).toBe(true)
      await settle()

      expect(host.applyLayout).toHaveBeenLastCalledWith(
        { type: 'closeBrowserPage', workspace: WT, browserTabId: 'page-1', pageId: 'page-2' },
        'local'
      )
      expect(host.session().browserTabsByWorktree?.[WT]).toEqual([
        expect.objectContaining({ id: 'page-1', pageIds: ['page-1'] })
      ])
      expect(host.session().browserPagesByWorkspace?.['page-1']?.map((page) => page.id)).toEqual([
        'page-1'
      ])
      expect(host.tabs.listUnstarted(WT).map((tab) => tab.browserPageId)).toEqual(['page-1'])
    })

    it('drops only that page when it closes while main is adding it', async () => {
      const host = await hostWithTab()

      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      expect(host.tabs.closed(WT, 'page-2')).toBe(true)
      await settle()

      expect(host.session().browserTabsByWorktree?.[WT]).toEqual([
        expect.objectContaining({ id: 'page-1', pageIds: ['page-1'] })
      ])
      expect(host.session().browserPagesByWorkspace?.['page-1']?.map((page) => page.id)).toEqual([
        'page-1'
      ])
    })

    it('closes the running page when main refuses the join, saving nothing', async () => {
      const host = await hostWithTab()
      host.applyLayout.mockResolvedValueOnce({ ok: false, code: 'tab_not_found' })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      await settle()

      expect(host.closeRunningPage).toHaveBeenCalledWith(WT, 'page-2')
      expect(host.session().browserPagesByWorkspace?.['page-1']?.map((page) => page.id)).toEqual([
        'page-1'
      ])
      warn.mockRestore()
    })

    it('lists and starts every saved page of the tab after a restart', async () => {
      const host = await hostWithTab()
      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      await settle()

      expect(host.tabs.listUnstarted(WT).map((tab) => tab.browserPageId)).toEqual([
        'page-1',
        'page-2'
      ])
      await expect(host.tabs.start(WT, 'page-2')).resolves.toBe(true)
      expect(host.createTab).toHaveBeenLastCalledWith(
        expect.objectContaining({ browserPageId: 'page-2', url: JOINED.url })
      )
      // With none named, the tab's shown page starts, as before.
      await expect(host.tabs.start(WT, undefined)).resolves.toBe(true)
      expect(host.createTab).toHaveBeenLastCalledWith(
        expect.objectContaining({ browserPageId: 'page-1' })
      )
    })

    it('lists only the shown page of a tab with the switch off', async () => {
      const host = await hostWithTab()
      host.tabs.opened({ ...JOINED, browserTabId: 'page-1' })
      await settle()
      layoutOwner.isMain = false

      expect(host.tabs.listUnstarted(WT).map((tab) => tab.browserPageId)).toEqual(['page-1'])
    })
  })
})
