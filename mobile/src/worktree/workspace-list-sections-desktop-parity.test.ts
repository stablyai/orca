import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_HEADERS,
  PROJECT_SECTION_PARITY_ROWS,
  PROJECT_SECTION_PARITY_SERVED
} from '../../../src/shared/project-section-parity.test-fixture'
import { buildProjectSectionCatalog } from './project-section-catalog'
import {
  projectSectionsRead,
  readServedProjectSections,
  type ServedProjectSections
} from './project-sections-operations'
import { buildMobileWorkspacePlan, buildSections, type Worktree } from './workspace-list-sections'
import { planSidebarRows } from '../../../src/shared/sidebar-list/sidebar-row-plan'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../src/shared/workspace-statuses'

// Counterpart: renderer sidebar/worktree-list-groups-mobile-parity.test.ts uses the same served project fixtures.

function served(): ServedProjectSections | null {
  const verdict = projectSectionsRead.interpret({
    id: 'sections',
    ok: true,
    result: { catalog: PROJECT_SECTION_PARITY_SERVED }
  })
  return verdict.accepted ? verdict.value : null
}

function rows(): Worktree[] {
  const repoById = new Map(PROJECT_SECTION_PARITY_SERVED.repos.map((repo) => [repo.id, repo]))
  return PROJECT_SECTION_PARITY_ROWS.flatMap((row) => {
    const repo = repoById.get(row.repoId)
    return repo
      ? [
          {
            worktreeId: row.id,
            repoId: row.repoId,
            hostId: getRepoExecutionHostId(repo),
            repo: repo.displayName,
            branch: 'feature',
            displayName: row.id,
            path: `${repo.path}-${row.id}`,
            lastActivityAt: row.lastActivityAt,
            liveTerminalCount: 0,
            hasAttachedPty: false,
            unread: false,
            isPinned: false,
            linkedPR: null
          }
        ]
      : []
  })
}

function headers(catalog: ReturnType<typeof buildProjectSectionCatalog>) {
  return buildSections(
    rows(),
    'recent',
    { ...NO_WORKSPACE_ROW_FILTERS },
    '',
    'repo',
    new Set(),
    catalog
  ).map((section) => ({ key: section.key, label: section.title }))
}

describe('Project grouping on the phone', () => {
  it.each(['recent', 'manual'] as const)(
    "renders the desktop sidebar's %s headers from the catalog the desktop serves",
    (projectOrderBy) => {
      expect(rows()).toHaveLength(PROJECT_SECTION_PARITY_ROWS.length)
      expect(headers(buildProjectSectionCatalog(served(), [], null, projectOrderBy))).toEqual(
        PROJECT_SECTION_PARITY_HEADERS[projectOrderBy]
      )
    }
  )

  it("groups by repo from an older desktop's own repos when it serves no catalog", () => {
    const desktopRepos = PROJECT_SECTION_PARITY_SERVED.repos.filter(
      (repo) => repo.executionHostId === 'local'
    )

    expect(headers(buildProjectSectionCatalog(null, desktopRepos, null, 'manual'))).toEqual([
      { key: 'repo:m4-orca-two', label: 'orca' },
      { key: 'repo:win-orca', label: 'orca' },
      { key: 'repo:local-workspace', label: 'orca/orca' },
      { key: 'repo:local-stably', label: 'stably/orca' },
      { key: 'repo:m4-orca', label: 'orca' },
      { key: 'repo:local-assets', label: 'design-assets' }
    ])
  })

  it('drops a served setup whose host id this build cannot read, keeping the rest', () => {
    const verdict = projectSectionsRead.interpret({
      id: 'sections',
      ok: true,
      result: {
        catalog: {
          ...PROJECT_SECTION_PARITY_SERVED,
          setups: [
            { ...PROJECT_SECTION_PARITY_SERVED.setups[0], hostId: 'nonsense' },
            ...PROJECT_SECTION_PARITY_SERVED.setups.slice(1)
          ]
        }
      }
    })

    expect(verdict.accepted && verdict.value?.setups).toHaveLength(
      PROJECT_SECTION_PARITY_SERVED.setups.length - 1
    )
  })
})

describe('readServedProjectSections', () => {
  it('reads a served catalog, and a desktop with no published window as none', () => {
    expect(
      readServedProjectSections({
        id: 'sections',
        ok: true,
        result: { catalog: PROJECT_SECTION_PARITY_SERVED }
      })
    ).toMatchObject({ kind: 'answered', value: { repos: expect.any(Array) } })
    expect(
      readServedProjectSections({ id: 'sections', ok: true, result: { catalog: null } })
    ).toEqual({ kind: 'answered', value: null })
  })

  it.each(['forbidden', 'method_not_found'])(
    'reads an older desktop that answers %s as serving none',
    (code) => {
      expect(
        readServedProjectSections({ id: 'sections', ok: false, error: { code, message: code } })
      ).toEqual({ kind: 'answered', value: null })
    }
  )

  it('keeps the last catalog after a timeout or a dropped reply', () => {
    expect(
      readServedProjectSections({
        id: 'sections',
        ok: false,
        error: { code: 'timeout', message: 'timed out' }
      })
    ).toEqual({ kind: 'kept' })
    expect(readServedProjectSections(null)).toEqual({ kind: 'kept' })
  })

  it('nests subfolder repo sections under their top umbrella repo on both desktop and mobile', () => {
    const k7Repo = {
      id: 'repo-k7',
      path: '/workspace/k7',
      displayName: 'k7',
      badgeColor: '#000000',
      addedAt: 1,
      executionHostId: 'local' as const
    }
    const k7hubRepo = {
      id: 'repo-k7hub',
      path: '/workspace/k7/k7hub',
      displayName: 'k7hub',
      badgeColor: '#111111',
      addedAt: 2,
      executionHostId: 'local' as const
    }
    const k7envRepo = {
      id: 'repo-k7env',
      path: '/workspace/k7/k7env',
      displayName: 'k7env',
      badgeColor: '#222222',
      addedAt: 3,
      executionHostId: 'local' as const
    }
    const desktopPlan = planSidebarRows({
      groupBy: 'repo',
      sortBy: 'manual',
      worktrees: [
        {
          id: 'repo-k7::/workspace/k7',
          repoId: 'repo-k7',
          path: '/workspace/k7',
          head: 'abc',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true,
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 100
        },
        {
          id: 'repo-k7hub::/workspace/k7/k7hub',
          repoId: 'repo-k7hub',
          path: '/workspace/k7/k7hub',
          head: 'def',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true,
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 90
        },
        {
          id: 'repo-k7env::/workspace/k7/k7env',
          repoId: 'repo-k7env',
          path: '/workspace/k7/k7env',
          head: 'ghi',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true,
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 2,
          lastActivityAt: 80
        }
      ],
      repoMap: new Map([
        [k7Repo.id, k7Repo],
        [k7hubRepo.id, k7hubRepo],
        [k7envRepo.id, k7envRepo]
      ]),
      prGroupOf: () => 'none',
      repoOrder: new Map([
        ['repo-k7', 0],
        ['repo-k7hub', 1],
        ['repo-k7env', 2]
      ]),
      workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
      projectOrderBy: 'manual',
      lineageById: {},
      worktreeMap: new Map(),
      nestLineage: false,
      projectGroups: [],
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [],
      defaultHostId: 'local',
      pinnedDisplayPolicy: 'duplicate-in-groups',
      filterRepoIds: []
    })

    expect(
      desktopPlan.render(new Set(['repo:repo-k7hub', 'repo:repo-k7env'])).map((row) => ({
        type: row.type,
        key: row.type === 'header' ? row.key : row.type === 'item' ? row.worktree.id : row.type,
        depth:
          row.type === 'header'
            ? (row.projectGroupDepth ?? 0)
            : row.type === 'item'
              ? (row.groupDepth ?? 0)
              : 0
      }))
    ).toEqual([
      { type: 'header', key: 'repo:repo-k7', depth: 0 },
      { type: 'item', key: 'repo-k7::/workspace/k7', depth: 0 },
      { type: 'header', key: 'umbrella-subfolders:repo:repo-k7', depth: 1 },
      { type: 'header', key: 'repo:repo-k7hub', depth: 2 },
      { type: 'header', key: 'repo:repo-k7env', depth: 2 }
    ])
    expect(
      desktopPlan.render(new Set(['umbrella-subfolders:repo:repo-k7'])).map((row) => ({
        type: row.type,
        key: row.type === 'header' ? row.key : row.type === 'item' ? row.worktree.id : row.type
      }))
    ).toEqual([
      { type: 'header', key: 'repo:repo-k7' },
      { type: 'item', key: 'repo-k7::/workspace/k7' },
      { type: 'header', key: 'umbrella-subfolders:repo:repo-k7' }
    ])
    expect(desktopPlan.render(new Set(['repo:repo-k7']))).toEqual([
      expect.objectContaining({ type: 'header', key: 'repo:repo-k7' })
    ])

    const mobilePlan = buildMobileWorkspacePlan(
      [
        {
          worktreeId: 'wt-k7',
          repoId: 'repo-k7',
          repo: 'k7',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/k7',
          lastActivityAt: 100,
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          linkedPR: null
        },
        {
          worktreeId: 'wt-k7hub',
          repoId: 'repo-k7hub',
          repo: 'k7hub',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/k7/k7hub',
          lastActivityAt: 90,
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          linkedPR: null
        },
        {
          worktreeId: 'wt-k7env',
          repoId: 'repo-k7env',
          repo: 'k7env',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/k7/k7env',
          lastActivityAt: 80,
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          linkedPR: null
        }
      ],
      'recent',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      {
        repos: [k7Repo, k7hubRepo, k7envRepo],
        grouping: null,
        repoOrder: new Map([
          ['repo-k7', 0],
          ['repo-k7hub', 1],
          ['repo-k7env', 2]
        ]),
        projectOrderBy: 'manual'
      }
    )

    expect(
      mobilePlan.render(new Set(['repo:repo-k7hub', 'repo:repo-k7env'])).map((s) => ({
        key: s.key,
        depth: s.projectGroupDepth ?? 0,
        parent: s.parentSectionKey ?? null,
        rows: s.data.map((r) => [r.row.worktreeId, r.view.projectGroupDepth ?? 0])
      }))
    ).toEqual([
      { key: 'repo:repo-k7', depth: 0, parent: null, rows: [['wt-k7', 0]] },
      {
        key: 'umbrella-subfolders:repo:repo-k7',
        depth: 1,
        parent: 'repo:repo-k7',
        rows: []
      },
      {
        key: 'repo:repo-k7hub',
        depth: 2,
        parent: 'umbrella-subfolders:repo:repo-k7',
        rows: [['wt-k7hub', 2]]
      },
      {
        key: 'repo:repo-k7env',
        depth: 2,
        parent: 'umbrella-subfolders:repo:repo-k7',
        rows: [['wt-k7env', 2]]
      }
    ])
    expect(
      mobilePlan.render(new Set(['umbrella-subfolders:repo:repo-k7'])).map((s) => s.key)
    ).toEqual(['repo:repo-k7', 'umbrella-subfolders:repo:repo-k7'])
    expect(mobilePlan.render(new Set(['repo:repo-k7'])).map((s) => s.key)).toEqual(['repo:repo-k7'])
  })
})
