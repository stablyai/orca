// Runs on plain Node, as orcad does: the reader imports no Electron.
import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ManualRepoOrderEntry } from '../../../shared/ui-chrome-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { readDesktopSidebarFacts, type DesktopSidebarFactSources } from './desktop-sidebar-facts'

function repo(id: string, connectionId: string | null = null): Repo {
  return { id, path: `/repos/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, connectionId }
}

function folder(id: string, isPinned: boolean): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-1',
    name: id,
    folderPath: `/folders/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function meta(isPinned: boolean, hostId?: ExecutionHostId): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(hostId ? { hostId } : {})
  }
}

function sources(overrides: {
  repos?: Repo[]
  metaByHost?: Record<string, Record<string, WorktreeMeta>>
  folders?: FolderWorkspace[]
  session?: { activeWorktreeId: string; activeWorkspaceExecutionHostId: ExecutionHostId }
  ui?: { manualRepoOrder?: ManualRepoOrderEntry[]; workspaceHostOrder?: ExecutionHostId[] }
}): DesktopSidebarFactSources {
  const metaFor = (hostId: string): Record<string, WorktreeMeta> =>
    overrides.metaByHost?.[hostId] ?? {}
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Group',
    parentPath: '/folders',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  return {
    store: {
      getRepos: () => overrides.repos ?? [],
      getProjectGroups: () => [group],
      getFolderWorkspaces: () => overrides.folders ?? [],
      getSshTargets: () => [],
      getAllWorktreeMeta: () => metaFor('local'),
      getAllWorktreeMetaForHost: metaFor,
      getWorkspaceSession: () =>
        overrides.session ?? { activeWorktreeId: null, activeWorkspaceExecutionHostId: null },
      getUI: () => ({
        manualRepoOrder: overrides.ui?.manualRepoOrder ?? [],
        workspaceHostOrder: overrides.ui?.workspaceHostOrder ?? []
      })
    },
    sshTargets: [],
    sshStateOf: () => undefined,
    wslStatuses: []
  }
}

describe('readDesktopSidebarFacts', () => {
  it('publishes the desktop focus the window saved to the local session', () => {
    const facts = readDesktopSidebarFacts(
      sources({
        session: { activeWorktreeId: 'repo-1::/w', activeWorkspaceExecutionHostId: 'ssh:box' }
      })
    )
    expect(facts.desktopActive).toEqual({ hostId: 'ssh:box', worktreeId: 'repo-1::/w' })
    expect(readDesktopSidebarFacts(sources({})).desktopActive).toEqual({
      hostId: null,
      worktreeId: null
    })
  })

  it('reads pins from each host metadata partition and from folder workspaces', () => {
    const facts = readDesktopSidebarFacts(
      sources({
        repos: [repo('repo-1'), repo('repo-2', 'box')],
        metaByHost: {
          local: { 'repo-1::/a': meta(true), 'repo-1::/b': meta(false) },
          'ssh:box': { 'repo-2::/c': meta(true) }
        },
        folders: [folder('f1', true), folder('f2', false)]
      })
    )
    expect(facts.pinnedWorkspaceIds).toEqual(['folder:f1', 'repo-1::/a', 'repo-2::/c'])
  })

  it('keeps each host to its own pins on a store without host-qualified metadata', () => {
    const base = sources({ repos: [repo('repo-1'), repo('repo-2', 'box')] })
    const facts = readDesktopSidebarFacts({
      ...base,
      store: {
        ...base.store,
        getAllWorktreeMetaForHost: undefined,
        getAllWorktreeMeta: () => ({
          'repo-1::/a': meta(true, 'local'),
          'repo-2::/c': meta(true, 'ssh:box'),
          'repo-9::/gone': meta(true, 'ssh:other')
        })
      }
    })
    expect(facts.pinnedWorkspaceIds).toEqual(['repo-1::/a', 'repo-2::/c'])
  })

  it('orders projects by the manual order, with unranked ones after in store order', () => {
    const facts = readDesktopSidebarFacts(
      sources({
        repos: [repo('a'), repo('b'), repo('c', 'box')],
        ui: {
          manualRepoOrder: [
            { hostId: 'ssh:box', repoId: 'c' },
            { hostId: 'local', repoId: 'b' }
          ]
        }
      })
    )
    expect(facts.repoOrder).toEqual([
      { hostId: 'ssh:box', repoId: 'c' },
      { hostId: 'local', repoId: 'b' },
      { hostId: 'local', repoId: 'a' }
    ])
  })

  it('publishes the saved host order and each SSH and WSL host connection state', () => {
    const base = sources({ ui: { workspaceHostOrder: ['ssh:box', 'local', 'ssh:box'] } })
    const facts = readDesktopSidebarFacts({
      ...base,
      sshTargets: [
        { id: 'box', label: 'Build box' },
        { id: 'idle', label: 'Idle' }
      ],
      sshStateOf: (targetId) => (targetId === 'box' ? { status: 'connected' } : undefined),
      wslStatuses: [{ environmentId: 'env-1', distro: 'Ubuntu', state: 'unverifiable' }]
    })
    expect(facts.workspaceHostOrder).toEqual(['ssh:box', 'local'])
    expect(facts.sshHosts).toEqual({
      'ssh:box': { label: 'Build box', status: 'connected' },
      'ssh:idle': { label: 'Idle', status: null }
    })
    expect(facts.wslHosts).toEqual({ 'runtime:env-1': { distro: 'Ubuntu', state: 'unverifiable' } })
  })
})
