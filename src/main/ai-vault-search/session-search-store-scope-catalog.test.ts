import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { sessionSearchScopeCatalogFromStore } from './session-search-store-scope-catalog'

function meta(hostId: WorktreeMeta['hostId']): WorktreeMeta {
  return {
    hostId,
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function store() {
  return {
    getRepos: () => [
      { id: 'local-repo', path: '/work/app' },
      { id: 'ssh-repo', path: '/srv/app', connectionId: 'box' }
    ],
    getProjects: () => [{ id: 'proj-1', sourceRepoIds: ['local-repo'] }],
    getProjectHostSetups: () => [
      { projectId: 'proj-1', hostId: 'local' as const, repoId: 'local-repo', path: '/work/app' },
      { projectId: 'proj-1', hostId: 'ssh:box' as const, repoId: 'ssh-repo', path: '/srv/app' }
    ],
    getAllWorktreeMeta: () => ({
      'local-repo::/work/one': meta('local'),
      'ssh-repo::/srv/one': meta('ssh:box')
    }),
    getSettings: () => ({ workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: true })
  }
}

describe('scope catalog from the profile store', () => {
  it('keeps only the rows the addressed execution host owns', () => {
    const local = sessionSearchScopeCatalogFromStore(store(), 'local')
    expect(local.repos.map((repo) => repo.id)).toEqual(['local-repo'])
    expect(local.projectHostSetups.map((setup) => setup.repoId)).toEqual(['local-repo'])
    expect(Object.keys(local.worktreeMeta)).toEqual(['local-repo::/work/one'])
  })

  it('answers for an SSH host from that host’s own rows, not the desktop’s', () => {
    const remote = sessionSearchScopeCatalogFromStore(store(), 'ssh:box')
    expect(remote.repos.map((repo) => repo.id)).toEqual(['ssh-repo'])
    expect(Object.keys(remote.worktreeMeta)).toEqual(['ssh-repo::/srv/one'])
  })

  it('carries the placement settings a managed worktree directory is derived from', () => {
    expect(sessionSearchScopeCatalogFromStore(store(), 'local').settings).toEqual({
      workspaceDir: '/home/me/orca/workspaces',
      nestWorkspaces: true
    })
  })
})
