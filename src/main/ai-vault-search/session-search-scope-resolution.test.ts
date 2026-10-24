import { describe, expect, it } from 'vitest'
import { projectHostSetupCompatibilityFromRepos } from '../../shared/project-host-setup-projection'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'
import { resolveSessionSearchScope } from './session-search-scope-resolution'

function catalog(overrides: Partial<SessionSearchScopeCatalog> = {}): SessionSearchScopeCatalog {
  return {
    repos: [{ id: 'repo-1', path: '/work/app', displayName: 'app', badgeColor: '', addedAt: 0 }],
    projects: [],
    projectHostSetups: [],
    worktreeMeta: {},
    settings: { workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: true },
    ...overrides
  }
}

function paths(resolution: ReturnType<typeof resolveSessionSearchScope>): string[] {
  return resolution.kind === 'resolved' ? [...resolution.paths].sort() : []
}

describe('workspace scope', () => {
  it('resolves a registered workspace to its directory', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'workspace', worktreeId: 'repo-1::/work/feature' },
        catalog({ worktreeMeta: { 'repo-1::/work/feature': {} } })
      )
    ).toEqual({ kind: 'resolved', paths: ['/work/feature'] })
  })

  it('resolves the repo checkout, which no worktree row has to vouch for', () => {
    expect(
      resolveSessionSearchScope({ kind: 'workspace', worktreeId: 'repo-1::/work/app' }, catalog())
    ).toEqual({ kind: 'resolved', paths: ['/work/app'] })
  })

  it('refuses a directory the client named that this host has not registered', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'workspace', worktreeId: 'repo-1::/etc' },
        catalog({ worktreeMeta: { 'repo-1::/work/feature': {} } })
      )
    ).toEqual({ kind: 'unknown' })
  })

  it('answers with the host’s own spelling of a registered id, not the caller’s', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'workspace', worktreeId: 'repo-1::/work/Feature/' },
        catalog({ worktreeMeta: { 'repo-1::/work/Feature': {} } })
      )
    ).toEqual({ kind: 'resolved', paths: ['/work/Feature'] })
  })

  it('adds the directories the workspace occupied before it was renamed', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'workspace', worktreeId: 'repo-1::/work/new-name' },
      catalog({
        worktreeMeta: {
          'repo-1::/work/new-name': { priorWorktreeIds: ['repo-1::/work/old-name'] }
        }
      })
    )
    expect(paths(resolution)).toEqual(['/work/new-name', '/work/old-name'])
  })

  it('leaves a prior path that another registered workspace now occupies to its owner', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'workspace', worktreeId: 'repo-1::/work/new-name' },
      catalog({
        worktreeMeta: {
          'repo-1::/work/new-name': { priorWorktreeIds: ['repo-1::/work/taken'] },
          'repo-1::/work/taken': {}
        }
      })
    )
    expect(paths(resolution)).toEqual(['/work/new-name'])
  })

  it('reads a folder workspace instance id as its folder', () => {
    const resolution = resolveSessionSearchScope(
      {
        kind: 'workspace',
        worktreeId: 'folder-1::/work/notes::workspace:11111111-1111-4111-8111-111111111111'
      },
      catalog({
        repos: [
          {
            id: 'folder-1',
            path: '/work/notes',
            kind: 'folder',
            displayName: 'notes',
            badgeColor: '',
            addedAt: 0
          }
        ]
      })
    )
    expect(paths(resolution)).toEqual(['/work/notes'])
  })

  it('refuses a workspace whose repo this host does not have', () => {
    expect(
      resolveSessionSearchScope({ kind: 'workspace', worktreeId: 'other::/work/app' }, catalog())
    ).toEqual({ kind: 'unknown' })
  })

  it('refuses when no catalog is installed, which is every host without a store', () => {
    expect(
      resolveSessionSearchScope({ kind: 'workspace', worktreeId: 'repo-1::/work/app' }, null)
    ).toEqual({ kind: 'unknown' })
  })
})

describe('project scope', () => {
  const projectCatalog = catalog({
    worktreeMeta: {
      'repo-1::/home/me/orca/workspaces/app/one': {},
      'repo-1::/home/me/orca/workspaces/app/two': {},
      'repo-1::/elsewhere/outside': { priorWorktreeIds: ['repo-1::/elsewhere/before'] }
    }
  })

  it('covers the checkout, the managed directory, external worktrees and prior paths', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      projectCatalog
    )
    expect(paths(resolution)).toEqual([
      '/elsewhere/before',
      '/elsewhere/outside',
      '/home/me/orca/workspaces/app',
      '/work/app'
    ])
  })

  it('folds hundreds of worktrees into the one directory that contains them', () => {
    const worktreeMeta: Record<string, Record<string, never>> = {}
    for (let index = 0; index < 580; index++) {
      worktreeMeta[`repo-1::/home/me/orca/workspaces/app/wt-${index}`] = {}
    }
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      catalog({ worktreeMeta })
    )
    expect(paths(resolution)).toEqual(['/home/me/orca/workspaces/app', '/work/app'])
  })

  it("uses a repo's own worktree base path instead of the global root", () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      catalog({ repos: [{ ...catalog().repos[0], worktreeBasePath: '/trees/app' }] })
    )
    // Include older worktrees created before the repo’s base path was configured.
    expect(paths(resolution)).toEqual(['/home/me/orca/workspaces/app', '/trees/app', '/work/app'])
  })

  it('hands a flat layout one path per worktree, with no cap to squeeze them through', () => {
    const worktreeMeta: Record<string, Record<string, never>> = {}
    for (let index = 0; index < 100; index++) {
      worktreeMeta[`repo-1::/home/me/ws/wt-${index}`] = {}
    }
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      catalog({ settings: { workspaceDir: '/home/me/ws', nestWorkspaces: false }, worktreeMeta })
    )
    expect(paths(resolution)).toHaveLength(101)
  })

  it('covers a workspace root the user has since moved away from', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      catalog({
        settings: {
          workspaceDir: '/home/me/orca/workspaces',
          nestWorkspaces: true,
          workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: true }]
        }
      })
    )
    expect(paths(resolution)).toEqual([
      '/home/me/orca/workspaces/app',
      '/old/workspaces/app',
      '/work/app'
    ])
  })

  it('claims no managed directory under flat placement, where the root is every project’s', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:repo-1' },
      catalog({
        settings: { workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: false },
        worktreeMeta: { 'repo-1::/home/me/orca/workspaces/one': {} }
      })
    )
    expect(paths(resolution)).toEqual(['/home/me/orca/workspaces/one', '/work/app'])
  })

  it('resolves a project id through this host’s setup for it', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'project:proj-1' },
      catalog({
        repos: [{ ...catalog().repos[0], path: '/srv/app' }],
        projects: [
          {
            id: 'proj-1',
            sourceRepoIds: ['repo-1'],
            displayName: 'app',
            badgeColor: '',
            createdAt: 0,
            updatedAt: 0
          }
        ],
        projectHostSetups: [
          {
            ...projectHostSetupCompatibilityFromRepos(catalog().repos).setups[0],
            projectId: 'proj-1',
            repoId: 'repo-1',
            path: '/srv/app',
            worktreeBasePath: '/srv/trees'
          }
        ]
      })
    )
    expect(paths(resolution)).toEqual(['/home/me/orca/workspaces/app', '/srv/app', '/srv/trees'])
  })

  it('takes a folder workspace project as its folder', () => {
    const resolution = resolveSessionSearchScope(
      { kind: 'project', projectKey: 'repo:folder-1' },
      catalog({
        repos: [
          {
            id: 'folder-1',
            path: '/work/notes',
            kind: 'folder',
            displayName: 'notes',
            badgeColor: '',
            addedAt: 0
          }
        ]
      })
    )
    expect(paths(resolution)).toEqual(['/work/notes'])
  })

  it('refuses a project this host has no repo, setup or workspace for', () => {
    expect(
      resolveSessionSearchScope({ kind: 'project', projectKey: 'project:elsewhere' }, catalog())
    ).toEqual({ kind: 'unknown' })
  })

  it('refuses a project set up on another host even when the id is known here', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'project', projectKey: 'project:proj-1' },
        catalog({
          projects: [
            {
              id: 'proj-1',
              sourceRepoIds: ['repo-elsewhere'],
              displayName: 'app',
              badgeColor: '',
              createdAt: 0,
              updatedAt: 0
            }
          ]
        })
      )
    ).toEqual({ kind: 'unknown' })
  })
})
