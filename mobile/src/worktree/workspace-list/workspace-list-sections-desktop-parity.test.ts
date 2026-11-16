import { NO_WORKSPACE_ROW_FILTERS } from '../../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_ROWS,
  PROJECT_SECTION_PARITY_SERVED
} from '../../../../src/shared/sidebar-list/sections/project-section-parity.test-fixture'
import { buildProjectSectionCatalog } from '../project-sections/project-section-catalog'
import { readServedProjectSections } from '../project-sections/project-sections-operations'
import { buildMobileWorkspacePlan, buildSections } from './workspace-list-sections'
import { planSidebarRows } from '../../../../src/shared/sidebar-list/sidebar-row-plan'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../src/shared/workspace/status/workspace-status-defaults'
import type { Worktree } from './workspace-list-types'
import type { ServedProjectSections } from '../../../../src/shared/sidebar-list/catalog/project-section-catalog-schema'
import type { ProjectGroup } from '../../../../src/shared/project/groups/project-group-types'

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
  it("groups by repo from an older desktop's own repos when it serves no catalog", () => {
    const desktopRepos = PROJECT_SECTION_PARITY_SERVED.repos.filter(
      (repo) => repo.executionHostId === 'local'
    )

    expect(headers(buildProjectSectionCatalog(null, desktopRepos, [], null, 'manual'))).toEqual([
      { key: 'repo:m4-orca-two', label: 'orca' },
      { key: 'repo:win-orca', label: 'orca' },
      { key: 'repo:local-workspace', label: 'orca/orca' },
      { key: 'repo:local-stably', label: 'stably/orca' },
      { key: 'repo:m4-orca', label: 'orca' },
      { key: 'repo:local-assets', label: 'design-assets' }
    ])
  })
})

function group(id: string, name: string, fields: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...fields
  }
}

function row(worktreeId: string, repoId: string, fields: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId,
    repoId,
    repo: repoId,
    branch: worktreeId,
    displayName: worktreeId,
    path: `/src/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...fields
  }
}

describe('Project groups on the phone', () => {
  const repos: ServedProjectSections['repos'] = [
    { id: 'infra-tf', displayName: 'infra-tf', path: '/src/infra-tf', projectGroupId: 'g-infra' },
    { id: 'dotfiles', displayName: 'dotfiles', path: '/src/dotfiles', projectGroupOrder: 1000 },
    { id: 'orca-docs', displayName: 'orca-docs', path: '/src/orca-docs', projectGroupId: 'g-docs' },
    {
      id: 'orca-mobile',
      displayName: 'orca-mobile',
      path: '/src/orca-mobile',
      projectGroupId: 'g-orca',
      projectGroupOrder: 1000
    },
    {
      id: 'orca',
      displayName: 'orca',
      path: '/src/orca',
      projectGroupId: 'g-orca',
      projectGroupOrder: 0
    }
  ]
  const groups = [
    group('g-infra', 'Infra', { rootProjectOrder: 2000, createdFrom: 'folder-scan' }),
    group('g-docs', 'Docs', { parentGroupId: 'g-orca' }),
    group('g-orca', 'Orca', { rootProjectOrder: 0 })
  ]
  const worktrees = [
    row('wt-infra', 'infra-tf'),
    row('wt-dotfiles', 'dotfiles'),
    row('wt-docs', 'orca-docs'),
    row('wt-mobile', 'orca-mobile'),
    row('wt-orca', 'orca'),
    row('scratch', 'folder-workspace:g-infra', { workspaceKind: 'folder-workspace' }),
    // An agent's worktree started from the folder workspace nests under it.
    row('wt-agent', 'infra-tf', { parentWorktreeId: 'scratch' })
  ]

  function tree(collapsed: Set<string>) {
    return buildSections(
      worktrees,
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      buildProjectSectionCatalog(
        { repos, projects: [], setups: [], projectOrderBy: 'manual', projectGroups: groups },
        [],
        [],
        null,
        'manual'
      ),
      undefined,
      collapsed
    ).map((section) => [
      section.key,
      section.projectGroupDepth ?? 0,
      section.count ?? null,
      section.data.map(
        ({ row, view }) =>
          `${row.worktreeId}@${view.projectGroupDepth ?? 0}${view.lineageDepth ? '+' : ''}`
      )
    ])
  }

  it('nests projects and folders under groups in the desktop sidebar order', () => {
    expect(tree(new Set())).toEqual([
      ['project-group:g-orca', 0, 3, []],
      ['repo:orca', 1, null, ['wt-orca@1']],
      ['repo:orca-mobile', 1, null, ['wt-mobile@1']],
      ['project-group:g-docs', 1, 1, []],
      ['repo:orca-docs', 2, null, ['wt-docs@2']],
      ['repo:dotfiles', 0, null, ['wt-dotfiles@0']],
      ['project-group:g-infra', 0, 2, ['scratch@1', 'wt-agent@1+']],
      // wt-agent still counts in its own project, as on the desktop.
      ['repo:infra-tf', 1, 2, ['wt-infra@1']]
    ])
  })

  it('hides everything under a collapsed group, nested groups included', () => {
    expect(tree(new Set(['project-group:g-orca'])).map(([key]) => key)).toEqual([
      'project-group:g-orca',
      'repo:dotfiles',
      'project-group:g-infra',
      'repo:infra-tf'
    ])
  })
})

describe('readServedProjectSections', () => {
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
    const umbrellaRepo = {
      id: 'repo-umbrella',
      path: '/workspace/umbrella',
      displayName: 'umbrella',
      badgeColor: '#000000',
      addedAt: 1,
      executionHostId: 'local' as const
    }
    const webRepo = {
      id: 'repo-web',
      path: '/workspace/umbrella/web',
      displayName: 'web',
      badgeColor: '#111111',
      addedAt: 2,
      executionHostId: 'local' as const
    }
    const apiRepo = {
      id: 'repo-api',
      path: '/workspace/umbrella/api',
      displayName: 'api',
      badgeColor: '#222222',
      addedAt: 3,
      executionHostId: 'local' as const
    }
    const desktopPlan = planSidebarRows({
      groupBy: 'repo',
      sortBy: 'manual',
      worktrees: [
        {
          id: 'repo-umbrella::/workspace/umbrella',
          repoId: 'repo-umbrella',
          path: '/workspace/umbrella',
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
          id: 'repo-web::/workspace/umbrella/web',
          repoId: 'repo-web',
          path: '/workspace/umbrella/web',
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
          id: 'repo-api::/workspace/umbrella/api',
          repoId: 'repo-api',
          path: '/workspace/umbrella/api',
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
        [umbrellaRepo.id, umbrellaRepo],
        [webRepo.id, webRepo],
        [apiRepo.id, apiRepo]
      ]),
      prGroupOf: () => 'none',
      repoOrder: new Map([
        ['repo-umbrella', 0],
        ['repo-web', 1],
        ['repo-api', 2]
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
      desktopPlan.render(new Set(['repo:repo-web', 'repo:repo-api'])).map((row) => ({
        type: row.type,
        key: row.type === 'header' ? row.key : row.type === 'item' ? row.worktree.id : row.type,
        depth:
          row.type === 'header'
            ? (row.projectGroupDepth ?? 0)
            : row.type === 'item'
              ? (row.groupDepth ?? 0)
              : -1
      }))
    ).toEqual([
      { type: 'header', key: 'repo:repo-umbrella', depth: 0 },
      { type: 'item', key: 'repo-umbrella::/workspace/umbrella', depth: 0 },
      { type: 'header', key: 'umbrella-subfolders:repo:repo-umbrella', depth: 1 },
      { type: 'header', key: 'repo:repo-web', depth: 2 },
      { type: 'header', key: 'repo:repo-api', depth: 2 }
    ])
    expect(
      desktopPlan.render(new Set(['umbrella-subfolders:repo:repo-umbrella'])).map((row) => ({
        type: row.type,
        key: row.type === 'header' ? row.key : row.type === 'item' ? row.worktree.id : row.type
      }))
    ).toEqual([
      { type: 'header', key: 'repo:repo-umbrella' },
      { type: 'item', key: 'repo-umbrella::/workspace/umbrella' },
      { type: 'header', key: 'umbrella-subfolders:repo:repo-umbrella' }
    ])
    expect(desktopPlan.render(new Set(['repo:repo-umbrella']))).toEqual([
      expect.objectContaining({ type: 'header', key: 'repo:repo-umbrella' })
    ])

    const mobilePlan = buildMobileWorkspacePlan(
      [
        {
          worktreeId: 'wt-umbrella',
          repoId: 'repo-umbrella',
          repo: 'umbrella',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/umbrella',
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          isMainWorktree: true,
          linkedPR: null
        },
        {
          worktreeId: 'wt-web',
          repoId: 'repo-web',
          repo: 'web',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/umbrella/web',
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          isMainWorktree: true,
          linkedPR: null
        },
        {
          worktreeId: 'wt-api',
          repoId: 'repo-api',
          repo: 'api',
          branch: 'main',
          displayName: 'main',
          path: '/workspace/umbrella/api',
          liveTerminalCount: 0,
          hasAttachedPty: false,
          unread: false,
          isPinned: false,
          isMainWorktree: true,
          linkedPR: null
        }
      ],
      'manual',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'repo',
      new Set(),
      {
        repos: [umbrellaRepo, webRepo, apiRepo],
        grouping: null,
        projectGroups: [],
        repoOrder: new Map([
          ['repo-umbrella', 0],
          ['repo-web', 1],
          ['repo-api', 2]
        ]),
        projectOrderBy: 'manual'
      }
    )

    expect(
      mobilePlan.render(new Set(['repo:repo-web', 'repo:repo-api'])).map((s) => ({
        key: s.key,
        depth: s.projectGroupDepth ?? 0,
        parent: s.parentSectionKey ?? null,
        rows: s.data.map((item) => [item.row.worktreeId, item.view.projectGroupDepth ?? 0])
      }))
    ).toEqual([
      { key: 'repo:repo-umbrella', depth: 0, parent: null, rows: [['wt-umbrella', 0]] },
      {
        key: 'umbrella-subfolders:repo:repo-umbrella',
        depth: 1,
        parent: 'repo:repo-umbrella',
        rows: []
      },
      {
        key: 'repo:repo-web',
        depth: 2,
        parent: 'umbrella-subfolders:repo:repo-umbrella',
        rows: [['wt-web', 2]]
      },
      {
        key: 'repo:repo-api',
        depth: 2,
        parent: 'umbrella-subfolders:repo:repo-umbrella',
        rows: [['wt-api', 2]]
      }
    ])
    expect(
      mobilePlan.render(new Set(['umbrella-subfolders:repo:repo-umbrella'])).map((s) => s.key)
    ).toEqual(['repo:repo-umbrella', 'umbrella-subfolders:repo:repo-umbrella'])
    expect(mobilePlan.render(new Set(['repo:repo-umbrella'])).map((s) => s.key)).toEqual([
      'repo:repo-umbrella'
    ])
  })
})
