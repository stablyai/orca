import { describe, expect, it } from 'vitest'
import { projectHostSetupCompatibilityFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import {
  compileSessionSearchProjectOwnership,
  sessionSearchProjectOwns
} from './session-search-project-ownership'
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
  const repos: Repo[] = [
    { id: 'local-repo', path: '/work/app', displayName: 'app', badgeColor: '', addedAt: 0 },
    {
      id: 'ssh-repo',
      path: '/srv/app',
      connectionId: 'box',
      displayName: 'app',
      badgeColor: '',
      addedAt: 1
    }
  ]
  const projection = projectHostSetupCompatibilityFromRepos(repos)
  return {
    getRepos: () => repos,
    getProjects: () => projection.projects,
    getProjectHostSetups: () => projection.setups,
    getAllWorktreeMeta: () => ({
      'local-repo::/work/one': meta('local'),
      'ssh-repo::/srv/one': meta('ssh:box')
    }),
    getSettings: () => ({ workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: true })
  }
}

describe('scope catalog from the profile store', () => {
  it('captures every Repo/setup before projection and applies filesystem eligibility afterwards', async () => {
    const local = sessionSearchScopeCatalogFromStore(store(), 'local')
    expect(local.repos.map((repo) => repo.id)).toEqual(['local-repo', 'ssh-repo'])
    expect(local.projectHostSetups.map((setup) => setup.repoId)).toEqual(['local-repo', 'ssh-repo'])
    const selection = await compileSessionSearchProjectOwnership(local, 'repo:local-repo')
    expect(sessionSearchProjectOwns(selection, '/work/app', '/native/session')).toBe(true)
    expect(sessionSearchProjectOwns(selection, '/srv/app', '/native/session')).toBe(false)
    expect(Object.keys(local.worktreeMeta)).toEqual(['local-repo::/work/one'])
  })

  it('answers for an SSH host from that host’s own rows, not the desktop’s', () => {
    const remote = sessionSearchScopeCatalogFromStore(store(), 'ssh:box')
    expect(remote.repos.map((repo) => repo.id)).toEqual(['local-repo', 'ssh-repo'])
    expect(Object.keys(remote.worktreeMeta)).toEqual(['ssh-repo::/srv/one'])
  })

  it('carries the placement settings a managed worktree directory is derived from', () => {
    expect(sessionSearchScopeCatalogFromStore(store(), 'local').settings).toEqual({
      workspaceDir: '/home/me/orca/workspaces',
      nestWorkspaces: true
    })
  })
})
