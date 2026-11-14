import { describe, expect, it } from 'vitest'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'
import { resolveSessionSearchScope } from './session-search-scope-resolution'

function catalog(overrides: Partial<SessionSearchScopeCatalog> = {}): SessionSearchScopeCatalog {
  return {
    repos: [{ id: 'repo-1', path: '/work/app' }],
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
  it('refuses a directory the client named that this host has not registered', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'workspace', worktreeId: 'repo-1::/etc' },
        catalog({ worktreeMeta: { 'repo-1::/work/feature': {} } })
      )
    ).toEqual({ kind: 'unknown' })
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
})

describe('project scope', () => {
  it('refuses a project set up on another host even when the id is known here', () => {
    expect(
      resolveSessionSearchScope(
        { kind: 'project', projectKey: 'project:proj-1' },
        catalog({ projects: [{ id: 'proj-1', sourceRepoIds: ['repo-elsewhere'] }] })
      )
    ).toEqual({ kind: 'unknown' })
  })
})
