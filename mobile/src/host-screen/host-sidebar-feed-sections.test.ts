import { describe, expect, it } from 'vitest'
import {
  buildSidebarFeedRows,
  type SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'

import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections, buildPreFeedSections } from './host-sidebar-feed-sections'
import {
  FEED_ROWS,
  SERVED_SECTIONS,
  feedDomains,
  feedKey,
  feedRow,
  liveRow,
  phoneView
} from './host-sidebar-feed.test-fixture'
import type { MobileViewState } from '../worktree/workspace-view-settings'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { readServedProjectSections } from '../worktree/project-sections-operations'
import type { LastVisitedWorktreeOnHost } from '../worktree/host-list-highlight'
import type { WorktreeHostContextView } from '../worktree/workspace-list-types'
import { NO_WORKTREE_HOST_CONTEXT } from '../worktree/worktree-host-context-labels'

const catalog = buildSidebarFeedCatalog(SERVED_SECTIONS, [], [])

function phoneFeedView(
  view: MobileViewState,
  showPinnedInGroups = false,
  hostPlatform: NodeJS.Platform | null = 'darwin'
): SidebarFeedView {
  return buildHostFeedView({
    view,
    projectOrderBy: 'manual',
    desktop: { ...feedDomains().desktop!, showPinnedInGroups },
    hostPlatform
  })
}

function sectionsFor(
  view: MobileViewState,
  options: {
    showPinnedInGroups?: boolean
    live?: ReturnType<typeof liveRow>[]
    /** Host context by worktree id, as the display pass looks it up. */
    hostContext?: ReadonlyMap<string, WorktreeHostContextView>
    search?: string
    lastVisited?: LastVisitedWorktreeOnHost | null
  } = {}
) {
  const built = buildSidebarFeedRows(
    feedDomains(),
    catalog,
    phoneFeedView(view, options.showPinnedInGroups)
  )
  return buildHostFeedSections({
    rows: built.sectionRows,
    lastVisited: options.lastVisited ?? null,
    liveRows: options.live ?? [],
    hostContextOf: (row) => options.hostContext?.get(row.worktreeId),
    repoHostIdByRepoId: new Map([['lab', 'ssh:gpu']]),
    search: options.search ?? ''
  })
}

function outline(sections: ReturnType<typeof sectionsFor>): string[] {
  return sections.flatMap((section) => [
    `${section.key} "${section.title}" ${String(section.count)}${section.icon ? ' pin' : ''}`,
    ...section.data.map(
      (row) =>
        `  ${row.view.sectionListKey} depth=${String(row.view.lineageDepth)}${row.row.isActive ? ' ACTIVE' : ''}`
    )
  ])
}

describe('the phone list from the sidebar feed', () => {
  it('files a grouped project under its group header, nested and in the group’s order', () => {
    const group = (id: string, name: string, extra: Partial<ProjectGroup> = {}): ProjectGroup => ({
      id,
      name,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0,
      ...extra
    })
    const served = readServedProjectSections({
      id: 'sections',
      ok: true,
      result: {
        catalog: {
          ...SERVED_SECTIONS,
          repos: [
            // Use reversed fixture order so only projectGroupOrder can produce the expected order.
            { ...SERVED_SECTIONS.repos[0]!, projectGroupId: 'pg-inner', projectGroupOrder: 1 },
            { ...SERVED_SECTIONS.repos[1]!, projectGroupId: 'pg-inner', projectGroupOrder: 0 }
          ],
          projectGroups: [
            group('pg-school', 'school'),
            group('pg-inner', 'inner', { parentGroupId: 'pg-school', createdFrom: 'folder-scan' })
          ]
        }
      }
    })
    if (served.kind !== 'answered' || !served.value) {
      throw new Error('expected a served catalog')
    }
    const grouped = buildSidebarFeedCatalog(served.value, [], [])
    const base = feedDomains()
    const domains = feedDomains({
      workspaces: new Map([
        ...base.workspaces,
        [feedKey('|orca::/w/solo'), feedRow({ id: 'orca::/w/solo', manualOrder: 4 })]
      ])
    })
    const built = buildSidebarFeedRows(domains, grouped, phoneFeedView(phoneView()))
    const sections = buildHostFeedSections({
      rows: built.sectionRows,
      lastVisited: null,
      liveRows: [],
      hostContextOf: NO_WORKTREE_HOST_CONTEXT,
      repoHostIdByRepoId: new Map([['lab', 'ssh:gpu']]),
      search: ''
    })
    const headers = sections.map(
      (section) =>
        `${section.title}${section.isProjectGroup ? ' group' : ''} depth=${String(section.projectGroupDepth ?? 0)}`
    )
    expect(headers).toEqual([
      'Pinned depth=0',
      'school group depth=0',
      'inner group depth=1',
      'lab depth=2',
      'orca depth=2'
    ])
    expect(
      sections
        .slice(-2)
        .map((section) =>
          section.data.map((row) => [
            row.view.projectGroupDepth,
            row.view.inFolderScanGroup === true
          ])
        )
    ).toEqual([[[2, true]], [[2, true]]])
    expect(sections.at(-2)?.data.map((row) => row.row.worktreeId)).toEqual(['lab::/w/gpu'])
  })

  describe('the highlight: only the workspace this phone last opened, where shown', () => {
    const active = (sections: ReturnType<typeof sectionsFor>) =>
      outline(sections).filter((line) => line.endsWith(' ACTIVE'))

    it('never matches a desktop row for a visit on a server of the same id', () => {
      const lastVisited = { worktreeId: 'orca::/w/child', executionHost: 'runtime:env-1' as const }
      expect(active(sectionsFor(phoneView(), { lastVisited }))).toEqual([])
    })
  })

  it('takes what the feed carries from the feed, over an older worktree.ps row', () => {
    const feedChild = {
      ...FEED_ROWS.child,
      displayName: 'new name',
      branch: 'new-branch',
      comment: 'new note',
      isUnread: true,
      isPinned: true
    }
    const built = buildSidebarFeedRows(
      feedDomains({
        workspaces: new Map([
          [feedKey('|orca::/w/parent'), FEED_ROWS.parent],
          [feedKey('|orca::/w/child'), feedChild]
        ])
      }),
      catalog,
      phoneFeedView(phoneView())
    )
    const stale = liveRow({
      worktreeId: 'orca::/w/child',
      displayName: 'old name',
      branch: 'old-branch',
      comment: 'old note',
      unread: false,
      isPinned: false,
      isArchived: true,
      liveTerminalCount: 3
    })
    const sections = buildHostFeedSections({
      rows: built.sectionRows,
      lastVisited: null,
      liveRows: [stale],
      hostContextOf: NO_WORKTREE_HOST_CONTEXT,
      repoHostIdByRepoId: new Map(),
      search: 'new name'
    })
    expect(sections.flatMap((section) => section.data.map((item) => item.row))).toEqual([
      expect.objectContaining({
        worktreeId: 'orca::/w/child',
        displayName: 'new name',
        branch: 'new-branch',
        comment: 'new note',
        unread: true,
        isPinned: true,
        isArchived: false,
        liveTerminalCount: 3
      })
    ])
  })

  it('never draws one host’s live row under another host’s workspace of the same id', () => {
    const sections = sectionsFor(phoneView(), {
      live: [liveRow({ worktreeId: 'lab::/w/gpu', hostId: 'local', liveTerminalCount: 5 })]
    })
    const remote = sections
      .flatMap((section) => section.data)
      .find((row) => row.row.worktreeId === 'lab::/w/gpu')
    expect(remote?.row).toMatchObject({ hostId: 'ssh:gpu', liveTerminalCount: 0 })
  })
})

describe('the phone list before the first feed read', () => {
  const cached = [
    liveRow({ worktreeId: 'orca::/w/b', displayName: 'beta' }),
    liveRow({ worktreeId: 'orca::/w/a', displayName: 'alpha' }),
    liveRow({ worktreeId: 'orca::/w/old', displayName: 'old', isArchived: true })
  ]
  const preFeedVisiting = (
    search: string,
    rows: typeof cached,
    lastVisited: LastVisitedWorktreeOnHost | null
  ) =>
    buildPreFeedSections({
      rows,
      hostContextOf: NO_WORKTREE_HOST_CONTEXT,
      view: phoneView(),
      search,
      repoHostIdByRepoId: new Map(),
      lastVisited
    })

  it('highlights the row this phone opened, never the one the desktop marked active', () => {
    const rows = [{ ...cached[0]!, isActive: true }, cached[1]!]
    const highlighted = (lastVisited: LastVisitedWorktreeOnHost | null) =>
      preFeedVisiting('', rows, lastVisited)[0]
        ?.data.filter((row) => row.row.isActive)
        .map((row) => row.row.worktreeId)
    expect(highlighted(null)).toEqual([])
    expect(highlighted({ worktreeId: 'orca::/w/a' })).toEqual(['orca::/w/a'])
    expect(highlighted({ worktreeId: 'orca::/w/gone' })).toEqual([])
  })
})

describe('a header repeated in two host sections', () => {
  it('gets a distinct list key in each section and one shared collapse key', () => {
    const projectHeader = {
      type: 'header' as const,
      key: 'project:p',
      label: 'P',
      count: 0,
      icon: { kind: 'project' as const }
    }
    const hostHeader = (hostId: 'local' | 'ssh:gpu') => ({
      type: 'host-header' as const,
      key: `host:${hostId}`,
      hostId,
      kind: hostId === 'local' ? ('local' as const) : ('ssh' as const),
      label: hostId,
      detail: '',
      health: 'available' as const,
      collapsed: false,
      count: 0
    })
    const sections = buildHostFeedSections({
      rows: [
        hostHeader('local'),
        { ...projectHeader, hostId: 'local' },
        hostHeader('ssh:gpu'),
        { ...projectHeader, hostId: 'ssh:gpu' }
      ],
      lastVisited: null,
      liveRows: [],
      hostContextOf: NO_WORKTREE_HOST_CONTEXT,
      repoHostIdByRepoId: new Map(),
      search: ''
    })

    expect(sections.map(({ key, collapseKey }) => [key, collapseKey ?? key])).toEqual([
      ['host:local', 'host:local'],
      ['project:p@local', 'project:p'],
      ['host:ssh:gpu', 'host:ssh:gpu'],
      ['project:p@ssh:gpu', 'project:p']
    ])
  })
})
