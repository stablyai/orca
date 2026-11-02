import { describe, expect, it } from 'vitest'
import {
  resolveMobileAiVaultSessionResumeTarget,
  type MobileAiVaultResumeCatalog
} from './agent-history-resume-target'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session-1',
    title: 'Resume target',
    cwd: '/Users/ada/repo/app',
    branch: null,
    model: null,
    filePath: '/Users/ada/.claude/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-29T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> & { worktreeId: string; path: string }): Worktree {
  return {
    repoId: 'local-repo',
    repo: 'orca',
    branch: 'main',
    displayName: overrides.worktreeId,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

function resolve(
  args: Omit<
    Parameters<typeof resolveMobileAiVaultSessionResumeTarget>[0],
    'catalog' | 'hostPlatform'
  > &
    Partial<MobileAiVaultResumeCatalog> & { hostPlatform?: NodeJS.Platform }
) {
  return resolveMobileAiVaultSessionResumeTarget({
    session: args.session,
    activeWorktreeId: args.activeWorktreeId,
    worktrees: args.worktrees,
    catalog: {
      repos: args.repos ?? [],
      folderWorkspaces: args.folderWorkspaces ?? [],
      projectGroups: args.projectGroups ?? []
    },
    hostPlatform: args.hostPlatform ?? 'darwin'
  })
}

describe('mobile AI Vault resume target guards', () => {
  it('uses host correspondence to select the owning folder instead of the active route', () => {
    const folder = worktree({
      worktreeId: 'folder:linked',
      repoId: 'folder-workspace:group',
      workspaceKind: 'folder-workspace',
      path: '/var/example'
    })
    const args = {
      session: session({ cwd: '/private/var/example', cwdAliases: ['/var/example'] }),
      activeWorktreeId: 'route',
      worktrees: [worktree({ worktreeId: 'route', path: '/elsewhere' }), folder],
      folderWorkspaces: [{ id: 'linked', projectGroupId: 'group', folderPath: '/var/example' }],
      projectGroups: [{ id: 'group', parentGroupId: null, connectionId: null }]
    }
    expect(resolve(args)).toMatchObject({
      status: 'ready',
      worktreeId: 'folder:linked',
      workspacePath: '/var/example'
    })
    expect(
      resolve({ ...args, session: { ...args.session, executionHostId: 'ssh:other' } }).status
    ).toBe('blocked')
  })

  const repos = [
    { id: 'local-repo', path: '/Users/ada/repo', connectionId: null },
    { id: 'ssh-repo', path: '/home/ada/ssh-repo', connectionId: 'builder' },
    {
      id: 'runtime-repo',
      path: '/workspace/runtime',
      connectionId: null,
      executionHostId: 'runtime:devbox' as const
    }
  ]
  const folderWorkspaces = [
    { id: 'folder-local', projectGroupId: 'group-local', folderPath: '/Users/ada/folder' },
    {
      id: 'folder-ssh',
      projectGroupId: 'group-local',
      folderPath: '/home/ada/folder',
      connectionId: 'folder-builder'
    },
    { id: 'folder-runtime', projectGroupId: 'group-runtime', folderPath: '/workspace/folder' }
  ]
  const projectGroups = [
    { id: 'group-local', parentGroupId: null, connectionId: null },
    { id: 'group-runtime', parentGroupId: null, executionHostId: 'runtime:devbox' as const }
  ]

  const WSL_TRANSCRIPT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\app\\s.jsonl'
  const sshSessionWorktree = worktree({
    worktreeId: 'ssh-session-wt',
    repoId: 'ssh-repo',
    path: '/home/ada/ssh-repo/feature'
  })

  it('resumes a WSL-stored session in an SSH workspace into that distro (#26818)', () => {
    const target = resolve({
      session: session({ cwd: '/home/ada/ssh-repo/feature/src', filePath: WSL_TRANSCRIPT }),
      activeWorktreeId: 'ssh-session-wt',
      worktrees: [sshSessionWorktree],
      repos
    })
    expect(target).toEqual({
      status: 'ready',
      worktreeId: 'ssh-session-wt',
      targetStatus: 'ssh',
      workspacePath: '/home/ada/ssh-repo/feature',
      terminalPlatform: null
    })
  })

  it('resumes a session scanned on the same SSH host in that host workspace', () => {
    const target = resolve({
      session: session({
        executionHostId: 'ssh:builder',
        cwd: '/home/ada/ssh-repo/feature/src',
        filePath: '/home/ada/.claude/projects/app/s.jsonl'
      }),
      activeWorktreeId: 'ssh-session-wt',
      worktrees: [sshSessionWorktree],
      repos
    })
    expect(target.status === 'ready' ? target.targetStatus : target.message).toBe('ssh')
  })

  it('blocks a session scanned on another SSH host', () => {
    const target = resolve({
      session: session({
        executionHostId: 'ssh:other',
        cwd: '/home/ada/ssh-repo/feature/src',
        filePath: '/home/ada/.claude/projects/app/s.jsonl'
      }),
      activeWorktreeId: 'ssh-session-wt',
      worktrees: [sshSessionWorktree],
      repos
    })
    expect(target.status).toBe('blocked')
  })

  it('resumes a WSL-stored session in an SSH folder workspace', () => {
    const target = resolve({
      session: session({ cwd: '/home/ada/folder/src', filePath: WSL_TRANSCRIPT }),
      activeWorktreeId: 'folder:folder-ssh',
      worktrees: [
        worktree({
          worktreeId: 'folder:folder-ssh',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/home/ada/folder'
        })
      ],
      repos,
      folderWorkspaces,
      projectGroups
    })
    expect(target.status === 'ready' ? target.targetStatus : target.message).toBe('ssh')
  })

  it('resolves project-scope rows to the matched session worktree before the route worktree', () => {
    const target = resolve({
      session: session({ cwd: '/Users/ada/repo/feature/src' }),
      activeWorktreeId: 'route-wt',
      worktrees: [
        worktree({ worktreeId: 'route-wt', path: '/Users/ada/repo/main' }),
        worktree({ worktreeId: 'session-wt', path: '/Users/ada/repo/feature' })
      ],
      repos
    })
    expect(target).toEqual({
      status: 'ready',
      worktreeId: 'session-wt',
      targetStatus: 'local',
      workspacePath: '/Users/ada/repo/feature',
      terminalPlatform: null
    })
  })

  it('falls back to the active route worktree when the session worktree is archived', () => {
    const target = resolve({
      session: session({ cwd: '/Users/ada/repo/archive/src' }),
      activeWorktreeId: 'route-wt',
      worktrees: [
        worktree({ worktreeId: 'route-wt', path: '/Users/ada/repo/main' }),
        worktree({
          worktreeId: 'archived-wt',
          path: '/Users/ada/repo/archive',
          isArchived: true
        })
      ],
      repos
    })
    expect(target).toEqual({
      status: 'ready',
      worktreeId: 'route-wt',
      targetStatus: 'local',
      workspacePath: '/Users/ada/repo/main',
      terminalPlatform: null
    })
  })

  it('blocks runtime targets when no supported fallback is available', () => {
    const target = resolve({
      session: session({ cwd: '/Users/ada/runtime/app' }),
      activeWorktreeId: 'runtime-wt',
      worktrees: [
        worktree({ worktreeId: 'runtime-wt', repoId: 'runtime-repo', path: '/Users/ada/runtime' })
      ],
      repos
    })
    expect(target.status).toBe('blocked')
    expect(target.status === 'blocked' ? target.message : '').toContain('runtime-hosted')
  })

  it('blocks SSH folder workspace targets for a host-local transcript', () => {
    const target = resolve({
      session: session({ cwd: '/home/ada/folder/src' }),
      activeWorktreeId: 'folder:folder-ssh',
      worktrees: [
        worktree({
          worktreeId: 'folder:folder-ssh',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/home/ada/folder'
        })
      ],
      repos,
      folderWorkspaces,
      projectGroups
    })
    expect(target.status).toBe('blocked')
    expect(target.status === 'blocked' ? target.message : '').toContain('different host')
  })

  it('skips an SSH session-worktree candidate in favor of a local active-worktree fallback', () => {
    const target = resolve({
      session: session({ cwd: '/home/ada/ssh-repo/feature/src' }),
      activeWorktreeId: 'route-wt',
      worktrees: [
        worktree({ worktreeId: 'route-wt', path: '/Users/ada/repo/main' }),
        worktree({
          worktreeId: 'ssh-session-wt',
          repoId: 'ssh-repo',
          path: '/home/ada/ssh-repo/feature'
        })
      ],
      repos
    })
    expect(target).toEqual({
      status: 'ready',
      worktreeId: 'route-wt',
      targetStatus: 'local',
      workspacePath: '/Users/ada/repo/main',
      terminalPlatform: null
    })
  })

  it('blocks SSH session worktrees with the SSH message when no local fallback exists', () => {
    const target = resolve({
      session: session({ cwd: '/home/ada/ssh-repo/feature/src' }),
      activeWorktreeId: 'ssh-session-wt',
      worktrees: [
        worktree({
          worktreeId: 'ssh-session-wt',
          repoId: 'ssh-repo',
          path: '/home/ada/ssh-repo/feature'
        })
      ],
      repos
    })
    expect(target.status).toBe('blocked')
    expect(target.status === 'blocked' ? target.message : '').toContain('different host')
  })

  it('blocks folder workspaces when folder metadata is unavailable', () => {
    const target = resolve({
      session: session({ cwd: '/Users/ada/folder/src' }),
      activeWorktreeId: 'folder:missing-folder',
      worktrees: [
        worktree({
          worktreeId: 'folder:missing-folder',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/Users/ada/folder'
        })
      ],
      repos,
      folderWorkspaces: [],
      projectGroups
    })
    expect(target).toEqual({
      status: 'blocked',
      message: 'Open a workspace before resuming a session.'
    })
  })

  it('refuses a session from an SSH host in a local workspace like desktop', () => {
    const target = resolve({
      session: session({ executionHostId: 'ssh:builder', cwd: '/Users/ada/repo/main/src' }),
      activeWorktreeId: 'route-wt',
      worktrees: [worktree({ worktreeId: 'route-wt', path: '/Users/ada/repo/main' })],
      repos
    })
    expect(target).toEqual({
      status: 'blocked',
      message:
        'This session belongs to a different host. Open a workspace on the same host to resume it.'
    })
  })

  it('refuses a WSL transcript in a native Windows workspace (#24408)', () => {
    const target = resolve({
      session: session({ cwd: 'C:\\repo\\src', filePath: WSL_TRANSCRIPT }),
      activeWorktreeId: 'route-wt',
      worktrees: [
        worktree({ worktreeId: 'route-wt', path: 'C:\\repo', terminalPlatform: 'win32' })
      ],
      repos,
      hostPlatform: 'win32'
    })
    expect(target.status).toBe('blocked')
  })

  it('resolves a folder workspace pinned to an SSH host by its own executionHostId', () => {
    const target = resolve({
      session: session({ executionHostId: 'ssh:pinned', cwd: '/home/ada/pinned/src' }),
      activeWorktreeId: 'folder:folder-pinned',
      worktrees: [
        worktree({
          worktreeId: 'folder:folder-pinned',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/home/ada/pinned'
        })
      ],
      repos,
      folderWorkspaces: [
        {
          id: 'folder-pinned',
          projectGroupId: 'group-local',
          folderPath: '/home/ada/pinned',
          executionHostId: 'ssh:pinned'
        }
      ],
      projectGroups
    })
    expect(target.status === 'ready' ? target.targetStatus : target.message).toBe('ssh')
  })

  it('blocks a route workspace that is gone from the live list even though its repo remains', () => {
    const target = resolve({
      session: session({ cwd: '/Users/ada/repo/deleted/src' }),
      activeWorktreeId: 'local-repo::/Users/ada/repo/deleted',
      worktrees: [],
      repos
    })
    expect(target.status).toBe('blocked')
  })

  it('attaches a session to the workspace on the host that recorded it when paths collide', () => {
    const target = resolve({
      session: session({ executionHostId: 'ssh:builder', cwd: '/srv/app/src' }),
      activeWorktreeId: null,
      worktrees: [
        worktree({ worktreeId: 'local-app', path: '/srv/app' }),
        worktree({ worktreeId: 'ssh-app', repoId: 'ssh-repo', path: '/srv/app' })
      ],
      repos
    })
    expect(target.status === 'ready' ? target.worktreeId : target.message).toBe('ssh-app')
  })

  it('attaches an SSH folder session to its folder, whose worktree.ps row has no hostId', () => {
    const target = resolve({
      session: session({ executionHostId: 'ssh:folder-builder', cwd: '/home/ada/folder/src' }),
      activeWorktreeId: 'route-wt',
      worktrees: [
        worktree({ worktreeId: 'route-wt', path: '/Users/ada/repo/main' }),
        worktree({
          worktreeId: 'folder:folder-ssh',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/home/ada/folder'
        })
      ],
      repos,
      folderWorkspaces,
      projectGroups
    })
    expect(target.status === 'ready' ? target.worktreeId : target.message).toBe('folder:folder-ssh')
  })
})
