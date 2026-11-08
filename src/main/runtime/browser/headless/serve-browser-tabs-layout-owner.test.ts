import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { applyCommandToSession } from '../../../persistence/terminal-topology/terminal-pane-admission'
import { ServeBrowserTabs } from './serve-browser-tabs'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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
  const tabs = new ServeBrowserTabs({
    backend: () => ({ createTab: vi.fn(), closeTab: vi.fn(), ownsTab: () => true }),
    livePageIds: () => new Set(),
    savedWorktreeIds: () => [WT],
    session: () => session,
    hostId: () => 'local',
    save,
    applyLayout
  })
  return { tabs, applyLayout, save, session: () => session }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('served browser tabs in a layout-owner build', () => {
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
})
