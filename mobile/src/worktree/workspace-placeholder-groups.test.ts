import { it, expect } from 'vitest'
import { join } from 'node:path'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { buildSections, type Worktree } from './workspace-list-sections'
import { buildProjectSectionCatalog } from './project-section-catalog'

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

it.each(['repository', 'host', 'folder'] as const)(
  'retains empty same-ID server registration and exact header Repo in the actual phone %s builder',
  (mode) => {
    const local = {
      id: 'same',
      displayName: 'App',
      path: '/local/app',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local' as const,
      upstream: { owner: 'org', repo: 'app' }
    }
    const remote = { ...local, path: '/server/app', executionHostId: 'runtime:server' as const }
    const plain = {
      id: 'plain',
      displayName: 'Plain',
      path: '/plain',
      kind: 'folder' as const,
      badgeColor: '',
      addedAt: 0
    }
    const repos = [local, remote, plain]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const served = buildMobileProjectSectionCatalog(repos, projection, 'manual', undefined, {
      projectGroupingMode: mode
    })
    const catalog = buildProjectSectionCatalog(served, [], null, null)
    const row = worktree({ repoId: 'same', repo: 'App', path: '/local/feature', hostId: 'local' })
    const build = (query = '') =>
      buildSections(
        [row],
        'manual',
        { ...NO_WORKSPACE_ROW_FILTERS },
        query,
        'repo',
        new Set(),
        catalog
      )
    const sections = build()
    expect(sections).toHaveLength(mode === 'repository' ? 2 : 3)
    expect(sections.find((section) => section.key === 'project:repo:plain')?.repo?.id).toBe('plain')
    if (mode !== 'repository') {
      const server = sections.find((section) => section.repo?.executionHostId === 'runtime:server')
      expect(server?.repo?.path).toBe('/server/app')
      expect(server?.data).toEqual([])
      expect(
        sections.find((section) => section.repo?.executionHostId === 'local')?.data
      ).toHaveLength(1)
    }
    expect(build('App').map((section) => section.repo?.id)).not.toContain('plain')
  }
)
