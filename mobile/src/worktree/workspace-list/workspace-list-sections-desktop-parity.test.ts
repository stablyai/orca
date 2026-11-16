import { NO_WORKSPACE_ROW_FILTERS } from '../../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import {
  PROJECT_SECTION_PARITY_ROWS,
  PROJECT_SECTION_PARITY_SERVED
} from '../../../../src/shared/sidebar-list/sections/project-section-parity.test-fixture'
import { buildProjectSectionCatalog } from '../project-sections/project-section-catalog'
import { readServedProjectSections } from '../project-sections/project-sections-operations'
import { buildSections } from './workspace-list-sections'
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
})
