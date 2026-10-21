import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { workspaceSessionStateSchema } from '../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  findSavedBrowserPage,
  withClosedServeBrowserTab,
  withOpenedServeBrowserTab,
  withServeBrowserPageState
} from './serve-browser-tab-layout'

const WT = 'repo-1::/repo'
const HOST = 'local'

function sessionWithTerminal(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        {
          id: 'term-1',
          ptyId: null,
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [WT]: [
        {
          id: 'term-1',
          entityId: 'term-1',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: 'term-1', tabOrder: ['term-1'] }]
    }
  }
}

const opened = (session: WorkspaceSessionState) =>
  withOpenedServeBrowserTab(HOST, session, {
    worktreeId: WT,
    pageId: 'page-1',
    url: 'https://example.com/',
    title: 'Example'
  })!

describe('a browser tab a host with no window saves', () => {
  it('is written in the shape a window writes, after the tabs before it', () => {
    const saved = opened(sessionWithTerminal())

    expect(workspaceSessionStateSchema.safeParse(saved).success).toBe(true)
    expect(saved.tabGroups?.[WT]?.[0]?.tabOrder).toEqual(['term-1', 'page-1'])
    expect(saved.unifiedTabs?.[WT]?.find((tab) => tab.id === 'page-1')).toMatchObject({
      entityId: 'page-1',
      contentType: 'browser',
      groupId: 'group-1'
    })
    expect(saved.browserTabsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: 'page-1',
        worktreeId: WT,
        pageIds: ['page-1'],
        url: 'https://example.com/',
        title: 'Example'
      })
    ])
    expect(saved.browserPagesByWorkspace?.['page-1']).toEqual([
      expect.objectContaining({
        id: 'page-1',
        workspaceId: 'page-1',
        worktreeId: WT,
        url: 'https://example.com/',
        title: 'Example'
      })
    ])
  })

  it('keeps its page last address', () => {
    const saved = withServeBrowserPageState(opened(sessionWithTerminal()), {
      worktreeId: WT,
      pageId: 'page-1',
      url: 'https://example.com/next',
      title: 'Next'
    })!

    expect(findSavedBrowserPage(saved, WT, 'page-1')?.page).toMatchObject({
      url: 'https://example.com/next',
      title: 'Next'
    })
    expect(saved.browserTabsByWorktree?.[WT]?.[0]).toMatchObject({
      url: 'https://example.com/next',
      title: 'Next'
    })
  })

  it('leaves no trace once closed', () => {
    const before = sessionWithTerminal()
    const saved = withClosedServeBrowserTab(HOST, opened(before), WT, 'page-1')!

    expect(saved.tabGroups?.[WT]?.[0]?.tabOrder).toEqual(['term-1'])
    expect(saved.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['term-1'])
    expect(saved.browserTabsByWorktree?.[WT] ?? []).toEqual([])
    expect(saved.browserPagesByWorkspace?.['page-1']).toBeUndefined()
  })

  it('updates only the page of a window-saved tab that is not its active one', () => {
    const session = opened(sessionWithTerminal())
    const windowSaved: WorkspaceSessionState = {
      ...session,
      browserTabsByWorktree: {
        [WT]: [{ ...session.browserTabsByWorktree![WT]![0]!, pageIds: ['page-1', 'page-2'] }]
      },
      browserPagesByWorkspace: {
        'page-1': [
          ...session.browserPagesByWorkspace!['page-1']!,
          { ...session.browserPagesByWorkspace!['page-1']![0]!, id: 'page-2', url: 'https://b/' }
        ]
      }
    }
    windowSaved.browserTabsByWorktree![WT]![0]!.activePageId = 'page-1'

    const saved = withServeBrowserPageState(windowSaved, {
      worktreeId: WT,
      pageId: 'page-2',
      url: 'https://b/next',
      title: 'B'
    })!

    expect(findSavedBrowserPage(saved, WT, 'page-2')?.page.url).toBe('https://b/next')
    expect(saved.browserTabsByWorktree?.[WT]?.[0]?.url).toBe('https://example.com/')
  })

  it('is saved once when its page is opened again', () => {
    const saved = opened(sessionWithTerminal())

    expect(
      withOpenedServeBrowserTab(HOST, saved, {
        worktreeId: WT,
        pageId: 'page-1',
        url: 'https://example.com/',
        title: 'Example'
      })
    ).toBeNull()
  })
})
