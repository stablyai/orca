import { describe, expect, it } from 'vitest'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  WorktreeMeta,
  WorkspaceSessionState
} from '../../shared/types'
import { resolvePaneSkillDiscoveryWorkspace } from './pane-skill-discovery-workspace'

const EMPTY_SESSION = { tabsByWorktree: {} } as WorkspaceSessionState

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/remote/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: 'target-1',
    ...overrides
  }
}

function worktreeMeta(hostId: WorktreeMeta['hostId']): WorktreeMeta {
  return {
    hostId,
    displayName: 'repo',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function session(
  worktreeId: string,
  startupCwd?: string,
  ptyId: string | null = null
): WorkspaceSessionState {
  return {
    tabsByWorktree: {
      [worktreeId]: [{ id: 'tab-1', ptyId, startupCwd }]
    }
  } as WorkspaceSessionState
}

describe('resolvePaneSkillDiscoveryWorkspace', () => {
  it('uses persisted pane ownership without scanning the repo catalog', () => {
    const worktreeId = 'repo-1::/remote/repo/worktree'
    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo()],
        projectGroups: [],
        folderWorkspaces: [],
        sessions: [
          { hostId: 'local', session: EMPTY_SESSION },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/remote/repo/packages/app') }
        ]
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/remote/repo/packages/app' })
  })

  it('accepts the legacy local mirror of an authoritative SSH pane session', () => {
    const worktreeId = 'repo-1::/work/demo-project'

    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: '/work/demo-project' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/work/demo-project') },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/work/demo-project') }
        ]
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/work/demo-project' })
  })

  it('accepts a legacy local SSH PTY mirror that omits its startup directory', () => {
    const worktreeId = 'repo-1::/work/demo-project'
    const ptyId = 'ssh:target-1@@pty-1'

    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: '/work/demo-project' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, undefined, ptyId) },
          {
            hostId: 'ssh:target-1',
            session: session(worktreeId, '/work/demo-project', ptyId)
          }
        ]
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/work/demo-project' })
  })

  it('rejects missing startup-directory mirrors with different PTY identities', () => {
    const worktreeId = 'repo-1::/work/demo-project'

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: '/work/demo-project' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, undefined, 'ssh:target-1@@pty-1') },
          {
            hostId: 'ssh:target-1',
            session: session(worktreeId, '/work/demo-project', 'ssh:target-1@@pty-2')
          }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('rejects a matching PTY identity from a different SSH target', () => {
    const worktreeId = 'repo-1::/work/demo-project'
    const ptyId = 'ssh:target-2@@pty-1'

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: '/work/demo-project' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, undefined, ptyId) },
          {
            hostId: 'ssh:target-1',
            session: session(worktreeId, '/work/demo-project', ptyId)
          }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('accepts normalized Windows variants of a mirrored SSH startup directory', () => {
    const worktreeId = 'repo-1::C:\\Repo'

    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: 'C:\\Repo' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, 'C:\\Repo\\') },
          { hostId: 'ssh:target-1', session: session(worktreeId, 'c:/repo') }
        ]
      })
    ).toEqual({ connectionId: 'target-1', cwd: 'c:/repo' })
  })

  it('keeps literal POSIX backslashes distinct when comparing mirrored sessions', () => {
    const worktreeId = 'repo-1::/srv/team/repo'

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo({ path: '/srv/team/repo' })],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/srv/team\\repo') },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/srv/team/repo') }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('rejects duplicate pane sessions on distinct non-local hosts', () => {
    const worktreeId = 'repo-1::/remote/repo'

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo()],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'ssh:target-1', session: session(worktreeId) },
          { hostId: 'ssh:target-2', session: session(worktreeId) }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('rejects a legacy local pane that does not mirror the SSH startup directory', () => {
    const worktreeId = 'repo-1::/remote/repo'

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [repo()],
        projectGroups: [],
        folderWorkspaces: [],
        worktreeMeta: worktreeMeta('ssh:target-1'),
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/local/repo') },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/remote/repo') }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('routes an executionHostId-only SSH repo instead of falling back locally', () => {
    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'repo-1::/remote/repo',
        repos: [repo({ connectionId: null, executionHostId: 'ssh:target-1' })],
        projectGroups: [],
        folderWorkspaces: [],
        sessions: []
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/remote/repo' })
  })

  it('uses the pane session to isolate duplicate repo identities across hosts', () => {
    const worktreeId = 'repo-1::/same/path'
    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [
          repo({ path: '/same/path', connectionId: 'target-1' }),
          repo({ path: '/same/path', connectionId: 'target-2' })
        ],
        projectGroups: [],
        folderWorkspaces: [],
        sessions: [{ hostId: 'ssh:target-2', session: session(worktreeId) }]
      })
    ).toEqual({ connectionId: 'target-2', cwd: '/same/path' })
  })

  it('rejects contradictory repo ownership instead of selecting either host', () => {
    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'repo-1::/remote/repo',
        repos: [repo({ connectionId: 'target-1', executionHostId: 'ssh:target-2' })],
        projectGroups: [],
        folderWorkspaces: [],
        sessions: []
      })
    ).toThrow('pane_skill_discovery_owner_invalid')
  })

  it('rejects an unpersisted renderer-claimed linked-worktree path', () => {
    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'repo-1::/remote/other',
        repos: [repo()],
        projectGroups: [],
        folderWorkspaces: [],
        sessions: []
      })
    ).toThrow('pane_skill_discovery_workspace_not_found')
  })

  it('resolves SSH folder workspaces from persisted folder ownership', () => {
    const group = {
      id: 'group-1',
      connectionId: 'target-1',
      parentPath: '/remote/folder'
    } as ProjectGroup
    const workspace = {
      id: 'folder-1',
      projectGroupId: group.id,
      folderPath: '/remote/folder',
      connectionId: 'target-1'
    } as FolderWorkspace
    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'folder:folder-1',
        repos: [],
        projectGroups: [group],
        folderWorkspaces: [workspace],
        sessions: []
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/remote/folder' })
  })

  it('accepts the local compatibility mirror of an authoritative SSH folder pane', () => {
    const worktreeId = 'folder:folder-1'
    const group = {
      id: 'group-1',
      connectionId: 'target-1',
      parentPath: '/remote/folder'
    } as ProjectGroup
    const workspace = {
      id: 'folder-1',
      projectGroupId: group.id,
      folderPath: '/remote/folder',
      connectionId: 'target-1'
    } as FolderWorkspace

    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [],
        projectGroups: [group],
        folderWorkspaces: [workspace],
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/remote/folder/packages/app') },
          {
            hostId: 'ssh:target-1',
            session: session(worktreeId, '/remote/folder/packages/app')
          }
        ]
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/remote/folder/packages/app' })
  })

  it('rejects a hostless folder-workspace rival before collapsing a local mirror', () => {
    const worktreeId = 'folder:folder-1'
    const workspace = {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/remote/folder',
      connectionId: 'target-1'
    } as FolderWorkspace

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [],
        projectGroups: [],
        folderWorkspaces: [workspace, { ...workspace, connectionId: null }],
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/remote/folder') },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/remote/folder') }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('rejects a hostless project-group rival before collapsing a local mirror', () => {
    const worktreeId = 'folder:folder-1'
    const workspace = {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/remote/folder'
    } as FolderWorkspace
    const group = {
      id: 'group-1',
      connectionId: 'target-1',
      parentPath: '/remote/folder'
    } as ProjectGroup

    expect(() =>
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId,
        terminalTabId: 'tab-1',
        repos: [],
        projectGroups: [group, { ...group, connectionId: null }],
        folderWorkspaces: [workspace],
        sessions: [
          { hostId: 'local', session: session(worktreeId, '/remote/folder') },
          { hostId: 'ssh:target-1', session: session(worktreeId, '/remote/folder') }
        ]
      })
    ).toThrow('pane_skill_discovery_owner_ambiguous')
  })

  it('routes an executionHostId-only SSH folder workspace', () => {
    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'folder:folder-1',
        repos: [],
        projectGroups: [],
        folderWorkspaces: [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            name: 'Remote folder',
            folderPath: '/remote/folder',
            connectionId: null,
            executionHostId: 'ssh:target-1',
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        sessions: []
      })
    ).toEqual({ connectionId: 'target-1', cwd: '/remote/folder' })
  })

  it('isolates duplicate folder project groups using persisted workspace ownership', () => {
    const workspace = {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/remote/folder',
      connectionId: 'target-2'
    } as FolderWorkspace
    const group = (connectionId: string): ProjectGroup =>
      ({
        id: 'group-1',
        connectionId,
        executionHostId: `ssh:${connectionId}`,
        parentPath: '/remote/folder'
      }) as ProjectGroup

    expect(
      resolvePaneSkillDiscoveryWorkspace({
        worktreeId: 'folder:folder-1',
        repos: [],
        projectGroups: [group('target-1'), group('target-2')],
        folderWorkspaces: [workspace],
        sessions: []
      })
    ).toEqual({ connectionId: 'target-2', cwd: '/remote/folder' })
  })
})
