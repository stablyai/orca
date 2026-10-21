import { describe, expect, it } from 'vitest'
import {
  buildSidebarFeedRows,
  type SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import type { ExecutionHostScope } from '../../../src/shared/execution-host'
import type { SidebarFeedDomains } from '../../../src/shared/sidebar-list/sidebar-feed-domains'
import { resolveVisibleWorkspaceHostIds } from '../../../src/shared/workspace-view/workspace-host-visibility'
import { buildSidebarFeedCatalog } from '../../../src/shared/sidebar-list/sidebar-feed-catalog'
import { buildHostFeedView } from './host-sidebar-feed-inputs'
import { buildHostFeedSections, buildPreFeedSections } from './host-sidebar-feed-sections'
import {
  FEED_ROWS,
  SERVED_SECTIONS,
  feedDomains,
  liveRow,
  phoneView
} from './host-sidebar-feed.test-fixture'
import type { MobileViewState } from '../worktree/workspace-view-settings'

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
    search?: string
  } = {}
) {
  const built = buildSidebarFeedRows(
    feedDomains(),
    catalog,
    phoneFeedView(view, options.showPinnedInGroups)
  )
  return buildHostFeedSections({
    rows: built.sectionRows,
    activeRowKeys: built.activeRowKeys,
    liveRows: options.live ?? [],
    repoHostIdByRepoId: new Map([['lab', 'ssh:gpu']]),
    search: options.search ?? ''
  })
}

function sectionsFromDomains(domains: SidebarFeedDomains, view: MobileViewState, search = '') {
  const built = buildSidebarFeedRows(domains, catalog, phoneFeedView(view))
  return buildHostFeedSections({
    rows: built.sectionRows,
    activeRowKeys: built.activeRowKeys,
    liveRows: [],
    repoHostIdByRepoId: new Map(),
    search
  })
}

function outline(sections: ReturnType<typeof sectionsFor>): string[] {
  return sections.flatMap((section) => [
    `${section.key} "${section.title}" ${String(section.count)}${section.icon ? ' pin' : ''}`,
    ...section.data.map(
      (row) =>
        `  ${row.sectionListKey} depth=${String(row.lineageDepth)}${row.isActive ? ' ACTIVE' : ''}`
    )
  ])
}

describe('the phone list from the sidebar feed', () => {
  it('draws the shared builder’s headers, order, nesting and single highlight', () => {
    const lines = outline(sectionsFor(phoneView()))
    // The pinned parent carries its nested child.
    expect(lines[0]).toMatch(/ "Pinned" 2 pin$/)
    expect(lines.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)
    expect(lines.some((line) => line.includes('orca::/w/child depth=1'))).toBe(true)
    expect(lines.some((line) => line.includes('"lab"'))).toBe(true)
  })

  it('highlights every occurrence when pinned rows also show in their groups', () => {
    const lines = outline(sectionsFor(phoneView(), { showPinnedInGroups: true }))
    expect(lines.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(2)
  })

  // The phone sends its host list resolved with an "all" scope; the desktop keeps its legacy scope.
  const scopes: [ExecutionHostScope, string[] | null][] = [
    ['ssh:gpu', null],
    ['all', ['local', 'ssh:gpu']],
    ['all', ['ssh:gpu']],
    ['local', ['local', 'ssh:gpu']]
  ]
  it.each(scopes)('builds the desktop’s rows for scope %s and hosts %j', (scope, hostIds) => {
    const visibleHostIds = resolveVisibleWorkspaceHostIds(hostIds, scope)
    const view = phoneView({ filters: { ...phoneView().filters, visibleHostIds } })
    const desktopView: SidebarFeedView = {
      ...phoneFeedView(view),
      workspaceHostScope: scope,
      visibleWorkspaceHostIds: hostIds && hostIds.length > 0 ? visibleHostIds : null
    }
    for (const groupBy of ['repo', 'none', 'workspace-status', 'pr-status'] as const) {
      const phone = buildSidebarFeedRows(
        feedDomains(),
        catalog,
        phoneFeedView({ ...view, groupBy })
      )
      const desktop = buildSidebarFeedRows(feedDomains(), catalog, { ...desktopView, groupBy })
      expect(JSON.stringify(phone.sectionRows)).toBe(JSON.stringify(desktop.sectionRows))
    }
  })

  // The test process runs on its own platform, which plays the phone's here.
  it.each([
    ['darwin', 'Local Mac'],
    ['win32', 'Local Windows'],
    [null, 'This computer']
  ] as const)(
    'names a %s desktop’s own host "%s", never by the phone’s platform',
    (platform, label) => {
      const view = phoneView({
        filters: { ...phoneView().filters, visibleHostIds: ['local', 'ssh:gpu'] }
      })
      const built = buildSidebarFeedRows(
        feedDomains(),
        catalog,
        phoneFeedView(view, false, platform)
      )
      const sections = buildHostFeedSections({
        rows: built.sectionRows,
        activeRowKeys: built.activeRowKeys,
        liveRows: [],
        repoHostIdByRepoId: new Map(),
        search: ''
      })
      expect(sections.map((section) => section.title)).toEqual(
        expect.arrayContaining([label, 'GPU box'])
      )
    }
  )

  it('draws each row with the live content worktree.ps served, matched by host', () => {
    const sections = sectionsFor(phoneView(), {
      live: [
        liveRow({ worktreeId: 'orca::/w/child', liveTerminalCount: 2, status: 'working' }),
        liveRow({
          worktreeId: 'lab::/w/gpu',
          hostId: 'ssh:gpu',
          repoId: 'lab',
          hasAttachedPty: true
        })
      ]
    })
    const rows = sections.flatMap((section) => section.data)
    expect(rows.find((row) => row.worktreeId === 'orca::/w/child')).toMatchObject({
      liveTerminalCount: 2,
      status: 'working',
      lineageDepth: 1
    })
    expect(rows.find((row) => row.worktreeId === 'lab::/w/gpu')).toMatchObject({
      hasAttachedPty: true
    })
    // Not listed by worktree.ps yet: drawn from the feed alone.
    expect(rows.find((row) => row.worktreeId === 'orca::/w/parent')).toMatchObject({
      displayName: 'orca::/w/parent',
      liveTerminalCount: 0,
      isPinned: true
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
          ['|orca::/w/parent', FEED_ROWS.parent],
          ['|orca::/w/child', feedChild]
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
      activeRowKeys: built.activeRowKeys,
      liveRows: [stale],
      repoHostIdByRepoId: new Map(),
      search: 'new name'
    })
    expect(sections.flatMap((section) => section.data)).toEqual([
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
      .find((row) => row.worktreeId === 'lab::/w/gpu')
    expect(remote).toMatchObject({ hostId: 'ssh:gpu', liveTerminalCount: 0 })
  })

  it('keeps a collapsed section’s header and count with no rows under it', () => {
    const expanded = sectionsFor(phoneView())
    const lab = expanded.find((section) => section.title === 'lab')!
    const collapsed = sectionsFor(phoneView({ collapsedGroups: [lab.key] }))
    expect(collapsed.find((section) => section.key === lab.key)).toMatchObject({
      count: 1,
      data: []
    })
  })

  it('draws a creation the host is running under its project, until the host lists it', () => {
    const creating = (worktreeId?: string) =>
      sectionsFromDomains(
        feedDomains({
          creations: new Map([['c1', { repoId: 'lab', ...(worktreeId ? { worktreeId } : {}) }]])
        }),
        phoneView()
      ).find((section) => section.title === 'lab')!
    expect(creating().pendingCreations).toEqual([{ key: 'pending:c1', repoName: null }])
    expect(creating().data.map((row) => row.worktreeId)).toEqual(['lab::/w/gpu'])
    // Once the host names a workspace it lists, only the workspace shows.
    expect(creating('lab::/w/gpu').pendingCreations).toBeUndefined()
  })

  it('draws creations above every group when not grouped by project', () => {
    const [first] = sectionsFromDomains(
      feedDomains({ creations: new Map([['c1', { repoId: 'orca' }]]) }),
      phoneView({ groupBy: 'none' })
    )
    expect(first).toMatchObject({ title: '', pendingCreations: [{ repoName: 'orca' }] })
  })

  it('drops a creation from a section search narrows to its matching rows', () => {
    const domains = feedDomains({ creations: new Map([['c1', { repoId: 'lab' }]]) })
    const lab = sectionsFromDomains(domains, phoneView(), 'gpu').find(
      (section) => section.title === 'lab'
    )
    expect(lab?.data.map((row) => row.worktreeId)).toEqual(['lab::/w/gpu'])
    expect(lab?.pendingCreations).toBeUndefined()
  })

  it('keeps a creation under its project header when the search matches that header', () => {
    const domains = feedDomains({ creations: new Map([['c1', { repoId: 'lab' }]]) })
    const lab = sectionsFromDomains(domains, phoneView(), 'lab').find(
      (section) => section.title === 'lab'
    )
    expect(lab?.pendingCreations).toEqual([{ key: 'pending:c1', repoName: null }])
  })

  it('narrows rows by search and drops sections left with none', () => {
    const sections = sectionsFor(phoneView(), { search: 'gpu' })
    expect(sections.flatMap((section) => section.data.map((row) => row.worktreeId))).toEqual([
      'lab::/w/gpu'
    ])
    expect(sections.map((section) => section.title)).toEqual(['lab'])
  })
})

describe('the phone list before the first feed read', () => {
  const cached = [
    liveRow({ worktreeId: 'orca::/w/b', displayName: 'beta' }),
    liveRow({ worktreeId: 'orca::/w/a', displayName: 'alpha' }),
    liveRow({ worktreeId: 'orca::/w/old', displayName: 'old', isArchived: true })
  ]
  const preFeed = (search: string, rows = cached) =>
    buildPreFeedSections({ rows, view: phoneView(), search, repoHostIdByRepoId: new Map() })

  it('shows the rows the page last listed, in their order under no header, filtered as the view is', () => {
    expect(preFeed('')).toEqual([{ key: 'all', title: '', data: cached.slice(0, 2) }])
  })

  it('narrows them by search, and draws nothing with none', () => {
    expect(preFeed('alp')[0]?.data.map((row) => row.worktreeId)).toEqual(['orca::/w/a'])
    expect(preFeed('', [])).toEqual([])
  })
})
