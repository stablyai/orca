import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { CREATE_GRACE_MS } from '../../../src/shared/workspace-view/workspace-row-sort'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-sections'
import {
  NO_PROJECT_SECTION_CATALOG,
  buildSections,
  filterWorktrees,
  getWorktreeStatus,
  sortWorktrees
} from './workspace-list-sections'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../src/shared/workspace-statuses'
import { getMobileWorkspaceLineageGroupKey } from './mobile-workspace-lineage'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

// A catalog of [displayName, id] repos with no project rows, as an old desktop answers.
function catalogOf(repos: readonly (readonly [string, string])[]) {
  return {
    ...NO_PROJECT_SECTION_CATALOG,
    repos: repos.map(([displayName, id]) => ({ id, displayName, path: `/repos/${id}` }))
  }
}

function withoutSectionListKeys(sections: ReturnType<typeof buildSections>) {
  return sections.map(({ repo: _repo, ...section }) => ({
    ...section,
    data: section.data.map(
      ({
        sectionListKey: _sectionListKey,
        lineageDepth: _lineageDepth,
        lineageChildCount: _lineageChildCount,
        lineageCollapsed: _lineageCollapsed,
        isLastLineageChild: _isLastLineageChild,
        showProjectName: _showProjectName,
        ...item
      }) => item
    )
  }))
}

describe('filterWorktrees', () => {
  it('hides archived worktrees', () => {
    const visible = worktree({ worktreeId: 'visible' })
    const archived = worktree({ worktreeId: 'archived', isArchived: true })

    expect(filterWorktrees([visible, archived], { ...NO_WORKSPACE_ROW_FILTERS }, '')).toEqual([
      visible
    ])
  })

  it('uses host sidebar activity for sleeping filtering when available', () => {
    const visible = worktree({
      worktreeId: 'visible',
      status: 'inactive',
      liveTerminalCount: 0,
      hasHostSidebarActivity: true
    })
    const retainedPtyOnly = worktree({
      worktreeId: 'retained-pty-only',
      status: 'active',
      liveTerminalCount: 3,
      hasHostSidebarActivity: false
    })

    expect(
      filterWorktrees(
        [visible, retainedPtyOnly],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([visible])
  })

  it('uses the host-provided main-worktree flag for default branch hiding', () => {
    const main = worktree({
      worktreeId: 'main',
      branch: 'main',
      isMainWorktree: true
    })
    const featureNamedMain = worktree({
      worktreeId: 'feature-main',
      branch: 'main',
      isMainWorktree: false
    })

    expect(
      filterWorktrees(
        [main, featureNamedMain],
        { ...NO_WORKSPACE_ROW_FILTERS, hideDefaultBranchWorkspace: true },
        ''
      )
    ).toEqual([featureNamedMain])
  })

  it('keeps a sleeping main worktree visible under hide-sleeping by default (#8873)', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })
    const feature = worktree({ worktreeId: 'feature', isMainWorktree: false })

    expect(
      filterWorktrees(
        [main, feature],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([main])
  })

  it('keeps a sleeping folder workspace visible under hide-sleeping', () => {
    const folder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:workspace-1',
      branch: '',
      isMainWorktree: true
    })

    expect(
      filterWorktrees([folder], { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true }, '')
    ).toEqual([folder])
  })

  it('re-hides the sleeping main worktree when the desktop setting is off', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })

    expect(
      filterWorktrees(
        [main],
        {
          ...NO_WORKSPACE_ROW_FILTERS,
          hideSleepingWorkspaces: true,
          alwaysShowDefaultBranchWorkspace: false
        },
        ''
      )
    ).toEqual([])
  })

  it('falls back to the branch heuristic for hosts that omit isMainWorktree', () => {
    const legacyMain = worktree({ worktreeId: 'legacy-main', branch: 'refs/heads/master' })

    expect(
      filterWorktrees(
        [legacyMain],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([legacyMain])
  })

  it('keeps a sleeping folder workspace on hosts that omit isMainWorktree', () => {
    // Legacy branch guessing cannot recognize branchless folder workspaces (#8873).
    const legacyFolder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:legacy-1',
      branch: ''
    })

    expect(
      filterWorktrees(
        [legacyFolder],
        { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
        ''
      )
    ).toEqual([legacyFolder])
  })

  it('lets hide-default-branch still win over the sleeping exemption', () => {
    const main = worktree({ worktreeId: 'main', branch: 'main', isMainWorktree: true })

    expect(
      filterWorktrees(
        [main],
        {
          ...NO_WORKSPACE_ROW_FILTERS,
          hideSleepingWorkspaces: true,
          hideDefaultBranchWorkspace: true
        },
        ''
      )
    ).toEqual([])
  })

  it('keeps folder workspaces when default branch hiding is enabled', () => {
    const folder = worktree({
      workspaceKind: 'folder-workspace',
      worktreeId: 'folder:workspace-1',
      branch: '',
      isMainWorktree: true
    })

    expect(
      filterWorktrees(
        [folder],
        { ...NO_WORKSPACE_ROW_FILTERS, hideDefaultBranchWorkspace: true },
        ''
      )
    ).toEqual([folder])
  })

  it("drops other-client rows only while the desktop's Hide other-client workspaces is on", () => {
    const mine = worktree({ worktreeId: 'mine' })
    const other = worktree({ worktreeId: 'other', desktopOtherClient: true })
    const hiding = { ...NO_WORKSPACE_ROW_FILTERS, hideWorkspacesFromOtherDevices: true }

    expect(filterWorktrees([mine, other], hiding, '')).toEqual([mine])
    expect(filterWorktrees([mine, other], NO_WORKSPACE_ROW_FILTERS, '')).toEqual([mine, other])
  })
})

describe('getWorktreeStatus', () => {
  it('uses host sidebar inactivity for the row status dot when available', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'active',
          liveTerminalCount: 3,
          hasHostSidebarActivity: false
        })
      )
    ).toBe('inactive')
  })

  it('marks host sidebar activity active when runtime status has not caught up', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'inactive',
          liveTerminalCount: 0,
          hasHostSidebarActivity: true
        })
      )
    ).toBe('active')
  })
})

describe('buildSections', () => {
  it('keys same-id rows by host inside a section', () => {
    const worktreeId = 'repo-1::/work/orca'
    const sections = buildSections(
      [worktree({ worktreeId, hostId: 'local' }), worktree({ worktreeId, hostId: 'ssh:builder' })],
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'none',
      new Set()
    )
    const keys = sections[0]?.data.map((item) => item.sectionListKey) ?? []

    expect(new Set(keys).size).toBe(2)
    expect(keys).toEqual(
      expect.arrayContaining([`all:local|${worktreeId}`, `all:ssh:builder|${worktreeId}`])
    )
  })

  it('matches desktop Name sort by display name', () => {
    const beta = worktree({ worktreeId: 'beta', displayName: 'Beta', repo: 'aaa' })
    const alpha = worktree({ worktreeId: 'alpha', displayName: 'Alpha', repo: 'zzz' })

    expect(sortWorktrees([beta, alpha], 'name').map((item) => item.worktreeId)).toEqual([
      'alpha',
      'beta'
    ])
  })

  it('uses desktop manual order ranks in Manual sort mode', () => {
    const low = worktree({ worktreeId: 'low', displayName: 'low', manualOrder: 10 })
    const high = worktree({ worktreeId: 'high', displayName: 'high', manualOrder: 30 })
    const fallback = worktree({ worktreeId: 'fallback', displayName: 'fallback', sortOrder: 20 })

    const sections = buildSections(
      [low, high, fallback],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual([
      'high',
      'fallback',
      'low'
    ])
  })

  it('uses desktop display-name tie-breaks in Manual sort mode', () => {
    const zed = worktree({ worktreeId: 'zed', displayName: 'Zed', manualOrder: 10 })
    const alpha = worktree({ worktreeId: 'alpha', displayName: 'Alpha', manualOrder: 10 })

    expect(sortWorktrees([zed, alpha], 'manual').map((item) => item.worktreeId)).toEqual([
      'alpha',
      'zed'
    ])
  })

  it('uses desktop-persisted smart order before mobile fallback signals', () => {
    const desktopFirst = worktree({
      worktreeId: 'desktop-first',
      displayName: 'desktop-first',
      sortOrder: 30,
      status: 'inactive',
      unread: false,
      lastOutputAt: 1
    })
    const mobileFallbackFirst = worktree({
      worktreeId: 'mobile-fallback-first',
      displayName: 'mobile-fallback-first',
      sortOrder: 10,
      status: 'working',
      unread: true,
      lastOutputAt: 100
    })

    const sections = buildSections(
      [mobileFallbackFirst, desktopFirst],
      'smart',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections.flatMap((section) => section.data.map((item) => item.worktreeId))).toEqual([
      'desktop-first',
      'mobile-fallback-first'
    ])
  })

  it('uses desktop display-name tie-breaks for equal persisted smart ranks', () => {
    const zed = worktree({ worktreeId: 'zed', displayName: 'Zed', sortOrder: 20, unread: true })
    const alpha = worktree({
      worktreeId: 'alpha',
      displayName: 'Alpha',
      sortOrder: 20,
      status: 'working',
      lastOutputAt: 100
    })

    expect(sortWorktrees([zed, alpha], 'smart').map((item) => item.worktreeId)).toEqual([
      'alpha',
      'zed'
    ])
  })

  it('counts live terminal output as Recent activity for headless serve hosts', () => {
    const streamingOnServe = worktree({
      worktreeId: 'streaming',
      displayName: 'streaming',
      lastActivityAt: 100,
      lastOutputAt: 1_000
    })
    const touchedOnDesktop = worktree({
      worktreeId: 'touched',
      displayName: 'touched',
      lastActivityAt: 200,
      lastOutputAt: 1
    })

    expect(
      sortWorktrees([touchedOnDesktop, streamingOnServe], 'recent').map((item) => item.worktreeId)
    ).toEqual(['streaming', 'touched'])
  })

  it('keeps desktop activity ranking in Recent when it is newest', () => {
    const newerActivity = worktree({
      worktreeId: 'newer-activity',
      displayName: 'newer',
      lastActivityAt: 2_000,
      lastOutputAt: 1
    })
    const quietOlder = worktree({
      worktreeId: 'quiet-older',
      displayName: 'quiet',
      lastActivityAt: 100,
      lastOutputAt: 150
    })

    expect(
      sortWorktrees([quietOlder, newerActivity], 'recent').map((item) => item.worktreeId)
    ).toEqual(['newer-activity', 'quiet-older'])
  })

  it('falls back to agent attention order in Smart when no desktop ranks exist', () => {
    // Display names are deliberately reverse-alphabetical to prove status ranks.
    const idle = worktree({ worktreeId: 'idle', displayName: 'Aardvark' })
    const needsPermission = worktree({
      worktreeId: 'needs-permission',
      displayName: 'Zebra',
      status: 'permission'
    })
    const working = worktree({ worktreeId: 'working', displayName: 'Yak', status: 'working' })

    expect(
      sortWorktrees([idle, working, needsPermission], 'smart').map((item) => item.worktreeId)
    ).toEqual(['needs-permission', 'working', 'idle'])
  })

  it('keeps desktop-ranked rows above unranked attention-fallback rows in Smart', () => {
    const ranked = worktree({ worktreeId: 'ranked', displayName: 'Ranked', sortOrder: 5 })
    const unrankedWorking = worktree({
      worktreeId: 'unranked-working',
      displayName: 'Working',
      status: 'working'
    })

    expect(
      sortWorktrees([unrankedWorking, ranked], 'smart').map((item) => item.worktreeId)
    ).toEqual(['ranked', 'unranked-working'])
  })

  it('matches desktop Recent create grace for newly-created workspaces', () => {
    const now = 10_000
    const created = worktree({
      worktreeId: 'created',
      displayName: 'created',
      lastActivityAt: 100,
      createdAt: now - 1_000
    })
    const active = worktree({
      worktreeId: 'active',
      displayName: 'active',
      lastActivityAt: now + CREATE_GRACE_MS - 2_000
    })

    expect(sortWorktrees([active, created], 'recent', now).map((item) => item.worktreeId)).toEqual([
      'created',
      'active'
    ])
  })

  it('matches desktop Repo sort by repo display name then workspace display name', () => {
    const betaAlpha = worktree({
      worktreeId: 'beta-alpha',
      repo: 'Beta Repo',
      displayName: 'Alpha'
    })
    const alphaZed = worktree({
      worktreeId: 'alpha-zed',
      repo: 'Alpha Repo',
      displayName: 'Zed'
    })
    const betaBravo = worktree({
      worktreeId: 'beta-bravo',
      repo: 'Beta Repo',
      displayName: 'Bravo'
    })

    expect(
      sortWorktrees([betaBravo, betaAlpha, alphaZed], 'repo').map((item) => item.worktreeId)
    ).toEqual(['alpha-zed', 'beta-alpha', 'beta-bravo'])
  })

  it('uses desktop localeCompare semantics for Repo sort names', () => {
    const accentRepo = worktree({
      worktreeId: 'accent-repo',
      repo: 'áb repo',
      displayName: 'Alpha'
    })
    const plainRepo = worktree({
      worktreeId: 'plain-repo',
      repo: 'ab repo',
      displayName: 'Zed'
    })

    expect(sortWorktrees([accentRepo, plainRepo], 'repo').map((item) => item.worktreeId)).toEqual([
      'plain-repo',
      'accent-repo'
    ])
  })

  it('keeps a desktop-ranked parent and child stack above unrelated active rows', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'Add agents to mobile',
      repo: 'orca',
      sortOrder: 30,
      status: 'inactive'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'Agent Session History resume (PR2)',
      repo: 'orca',
      parentWorktreeId: 'parent',
      sortOrder: 20,
      status: 'inactive'
    })
    const unrelatedActive = worktree({
      worktreeId: 'active',
      displayName: 'Overlapping tui output',
      repo: 'orca',
      sortOrder: 10,
      status: 'working',
      unread: true,
      lastOutputAt: 100
    })

    const sections = buildSections(
      [unrelatedActive, child, parent],
      'smart',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      catalogOf([['orca', 'repo-1']]),
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections[0]?.data.map((item) => item.worktreeId)).toEqual(['parent', 'child', 'active'])
    expect(sections[0]?.data.map((item) => item.lineageDepth)).toEqual([0, 1, 0])
  })

  it('keeps the main workspace first inside repo-grouped sections like desktop', () => {
    const child = worktree({
      worktreeId: 'child',
      displayName: 'Child',
      repo: 'orca',
      sortOrder: 30,
      isMainWorktree: false
    })
    const main = worktree({
      worktreeId: 'main',
      displayName: 'Main',
      repo: 'orca',
      sortOrder: 10,
      isMainWorktree: true
    })

    const sections = buildSections(
      [child, main],
      'smart',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      catalogOf([['orca', 'repo-1']])
    )

    expect(sections[0]?.data.map((item) => item.worktreeId)).toEqual(['main', 'child'])
  })

  it('renders empty repo sections from repo placeholders in repo grouping', () => {
    const sections = buildSections(
      [worktree({ repoId: 'repo-1', repo: 'orca' })],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      catalogOf([
        ['orca', 'repo-1'],
        ['zoom-img', 'repo-missing']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      {
        key: 'repo:repo-1',
        title: 'orca',
        data: [worktree({ repoId: 'repo-1', repo: 'orca' })]
      },
      { key: 'repo:repo-missing', title: 'zoom-img', data: [] }
    ])
  })

  it('does not render empty repo sections outside repo grouping', () => {
    const sections = buildSections(
      [],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'none',
      new Set(),
      catalogOf([['zoom-img', 'repo-missing']])
    )

    expect(withoutSectionListKeys(sections)).toEqual([])
  })

  it('applies repo filters and search to empty repo sections', () => {
    const sections = buildSections(
      [],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['repo-matching', 'repo-hidden'] },
      'zoom',
      'repo',
      new Set(),
      catalogOf([
        ['zoom-img', 'repo-matching'],
        ['repo', 'repo-hidden'],
        ['zoom-hidden', 'repo-unfiltered']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      { key: 'repo:repo-matching', title: 'zoom-img', data: [] }
    ])
  })

  it('does not add an empty repo section when all of its worktrees are filtered out', () => {
    const sleeping = worktree({
      repoId: 'repo-sleeping',
      repo: 'sleeping-repo',
      hasHostSidebarActivity: false
    })
    const sections = buildSections(
      [sleeping],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
      '',
      'repo',
      new Set(),
      catalogOf([
        ['sleeping-repo', 'repo-sleeping'],
        ['empty-repo', 'repo-empty']
      ])
    )

    expect(withoutSectionListKeys(sections)).toEqual([
      { key: 'repo:repo-empty', title: 'empty-repo', data: [] }
    ])
  })

  it("groups by PR into the desktop's lanes, order and labels", () => {
    const sections = buildSections(
      [
        worktree({ worktreeId: 'none', linkedPR: null }),
        worktree({ worktreeId: 'open', linkedPR: { number: 1, state: 'open' } }),
        worktree({ worktreeId: 'merged', linkedPR: { number: 2, state: 'merged' } })
      ],
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'pr-status',
      new Set()
    )
    expect(sections.map((section) => ({ key: section.key, title: section.title }))).toEqual([
      { key: 'pr:done', title: 'Done' },
      { key: 'pr:in-review', title: 'In review' },
      { key: 'pr:in-progress', title: 'In progress' }
    ])
  })

  it('groups by desktop workspace status labels and order', () => {
    const review = worktree({
      worktreeId: 'review',
      workspaceStatus: 'in-review',
      status: 'active'
    })
    const progress = worktree({
      worktreeId: 'progress',
      workspaceStatus: 'in-progress',
      status: 'working'
    })

    const sections = buildSections(
      [progress, review],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections.map((section) => ({ key: section.key, title: section.title }))).toEqual([
      { key: 'workspace-status:in-progress', title: 'In progress' },
      { key: 'workspace-status:in-review', title: 'In review' }
    ])
  })

  it('falls back to the default status catalog when desktop sends none', () => {
    const progress = worktree({
      worktreeId: 'progress',
      workspaceStatus: 'in-progress',
      status: 'working'
    })

    const sections = buildSections(
      [progress],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      []
    )

    expect(sections.map((section) => ({ key: section.key, title: section.title }))).toEqual([
      { key: 'workspace-status:in-progress', title: 'In progress' }
    ])
    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['progress'])
  })

  describe.each(['none', 'repo', 'workspace-status', 'pr-status'] as const)(
    'pinned placement in %s grouping',
    (groupMode) => {
      const sibling = worktree({ worktreeId: 'sibling', workspaceStatus: 'in-progress' })
      const hostPinned = worktree({
        worktreeId: 'host-pinned',
        workspaceStatus: 'in-progress',
        isPinned: true
      })
      const localPinned = worktree({ worktreeId: 'local-pinned', workspaceStatus: 'in-progress' })

      function placement(showPinnedInGroups: boolean) {
        const sections = buildSections(
          [sibling, hostPinned, localPinned],
          'name',
          { ...NO_WORKSPACE_ROW_FILTERS },
          '',
          groupMode,
          new Set(['local-pinned']),
          NO_PROJECT_SECTION_CATALOG,
          DEFAULT_WORKSPACE_STATUSES,
          new Set(),
          showPinnedInGroups
        )
        const ids = (keep: (key: string) => boolean) =>
          sections
            .filter((section) => keep(section.key))
            .flatMap((section) => section.data.map((row) => row.worktreeId))
            .sort()
        return { pinned: ids((key) => key === 'pinned'), groups: ids((key) => key !== 'pinned') }
      }

      it('shows host and local pins only in Pinned by default', () => {
        expect(placement(false)).toEqual({
          pinned: ['host-pinned', 'local-pinned'],
          groups: ['sibling']
        })
      })

      it('also keeps them in their groups when the desktop setting is on', () => {
        expect(placement(true)).toEqual({
          pinned: ['host-pinned', 'local-pinned'],
          groups: ['host-pinned', 'local-pinned', 'sibling']
        })
      })
    }
  )

  it('drops a repo group whose only worktree is pinned, like desktop', () => {
    const pinned = worktree({ worktreeId: 'pinned', isPinned: true })

    const sections = buildSections(
      [pinned],
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      catalogOf([['orca', 'repo-1']])
    )

    expect(sections.map((section) => section.key)).toEqual(['pinned'])
  })

  it('renders one sorted All section when grouping is off like desktop', () => {
    const inactiveFirst = worktree({
      worktreeId: 'inactive-first',
      displayName: 'inactive-first',
      manualOrder: 30,
      status: 'inactive'
    })
    const activeSecond = worktree({
      worktreeId: 'active-second',
      displayName: 'active-second',
      manualOrder: 10,
      status: 'working'
    })

    const sections = buildSections(
      [activeSecond, inactiveFirst],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'none',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections.map((section) => section.key)).toEqual(['all'])
    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual([
      'inactive-first',
      'active-second'
    ])
  })

  it('nests child workspaces under visible parents in grouped sections', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'parent',
      workspaceStatus: 'in-progress'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'child',
      parentWorktreeId: 'parent',
      workspaceStatus: 'in-progress'
    })

    const sections = buildSections(
      [child, parent],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['parent', 'child'])
    expect(sections[0]?.data.map((worktree) => worktree.lineageDepth)).toEqual([0, 1])
  })

  it('collapses child workspaces under lineage parent rows', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'parent',
      workspaceStatus: 'in-progress'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'child',
      parentWorktreeId: 'parent',
      workspaceStatus: 'in-progress'
    })

    const sections = buildSections(
      [child, parent],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'workspace-status',
      new Set(),
      NO_PROJECT_SECTION_CATALOG,
      DEFAULT_WORKSPACE_STATUSES,
      new Set([getMobileWorkspaceLineageGroupKey(parent)])
    )

    expect(sections[0]?.data.map((worktree) => worktree.worktreeId)).toEqual(['parent'])
    expect(sections[0]?.data[0]?.lineageChildCount).toBe(1)
    expect(sections[0]?.data[0]?.lineageCollapsed).toBe(true)
  })
})
