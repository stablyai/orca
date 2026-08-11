import { describe, expect, it } from 'vitest'
import {
  getMobileAiVaultResumeRepoTargetStatus,
  getMobileAiVaultResumeWorktreeTargetStatus,
  isSupportedMobileAiVaultResumeTargetStatus,
  mobileAiVaultResumeTargetBlockMessage,
  resolveMobileAiVaultSessionResumeTarget
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
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

describe('mobile AI Vault resume target guards', () => {
  const worktrees = [
    { worktreeId: 'local-wt', repoId: 'local-repo' },
    { worktreeId: 'ssh-wt', repoId: 'ssh-repo' },
    { worktreeId: 'runtime-wt', repoId: 'runtime-repo' },
    { worktreeId: 'host-owned-wt', repoId: 'local-repo', hostId: 'ssh:builder' as const },
    {
      worktreeId: 'folder:folder-local',
      repoId: 'folder-workspace:group-local',
      workspaceKind: 'folder-workspace' as const
    },
    {
      worktreeId: 'folder:folder-ssh',
      repoId: 'folder-workspace:group-local',
      workspaceKind: 'folder-workspace' as const
    },
    {
      worktreeId: 'folder:folder-runtime',
      repoId: 'folder-workspace:group-runtime',
      workspaceKind: 'folder-workspace' as const
    }
  ]
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
    { id: 'group-local', connectionId: null },
    { id: 'group-runtime', executionHostId: 'runtime:devbox' as const }
  ]

  it('classifies local, SSH, runtime, and unknown repos', () => {
    expect(getMobileAiVaultResumeRepoTargetStatus(repos[0])).toBe('local')
    expect(getMobileAiVaultResumeRepoTargetStatus(repos[1])).toBe('ssh')
    expect(getMobileAiVaultResumeRepoTargetStatus(repos[2])).toBe('runtime')
    expect(getMobileAiVaultResumeRepoTargetStatus(null)).toBe('unknown')
  })

  it('classifies worktrees from their repo, with worktree host taking precedence', () => {
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({ worktreeId: 'local-wt', worktrees, repos })
    ).toBe('local')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({ worktreeId: 'ssh-wt', worktrees, repos })
    ).toBe('ssh')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({ worktreeId: 'runtime-wt', worktrees, repos })
    ).toBe('runtime')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({ worktreeId: 'host-owned-wt', worktrees, repos })
    ).toBe('ssh')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({
        worktreeId: 'folder:folder-local',
        worktrees,
        repos,
        folderWorkspaces,
        projectGroups
      })
    ).toBe('local')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({
        worktreeId: 'folder:folder-ssh',
        worktrees,
        repos,
        folderWorkspaces,
        projectGroups
      })
    ).toBe('ssh')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({
        worktreeId: 'folder:folder-runtime',
        worktrees,
        repos,
        folderWorkspaces,
        projectGroups
      })
    ).toBe('runtime')
    expect(
      getMobileAiVaultResumeWorktreeTargetStatus({ worktreeId: 'missing', worktrees, repos })
    ).toBe('unknown')
  })

  it('supports local targets only; SSH hosts cannot see host-local transcripts', () => {
    expect(isSupportedMobileAiVaultResumeTargetStatus('local')).toBe(true)
    expect(isSupportedMobileAiVaultResumeTargetStatus('ssh')).toBe(false)
    expect(isSupportedMobileAiVaultResumeTargetStatus('runtime')).toBe(false)
    expect(mobileAiVaultResumeTargetBlockMessage('runtime')).toContain('runtime-hosted')
    expect(mobileAiVaultResumeTargetBlockMessage('ssh')).toContain('SSH workspace')
    expect(mobileAiVaultResumeTargetBlockMessage('ssh')).toContain('local workspace')
    expect(mobileAiVaultResumeTargetBlockMessage('unknown')).toContain('local workspace')
  })

  it('resolves project-scope rows to the matched session worktree before the route worktree', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
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
    const target = resolveMobileAiVaultSessionResumeTarget({
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
    const target = resolveMobileAiVaultSessionResumeTarget({
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

  it('blocks SSH folder workspace targets because transcripts are host-local', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
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
    expect(target.status === 'blocked' ? target.message : '').toContain('SSH workspace')
  })

  it('skips an SSH session-worktree candidate in favor of a local active-worktree fallback', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
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
    const target = resolveMobileAiVaultSessionResumeTarget({
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
    expect(target.status === 'blocked' ? target.message : '').toContain('SSH workspace')
  })

  it('blocks folder workspaces whose candidate repos include a runtime owner', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
      session: session({ cwd: '/workspace/folder/src' }),
      activeWorktreeId: 'folder:folder-runtime-candidate',
      worktrees: [
        worktree({
          worktreeId: 'folder:folder-runtime-candidate',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/workspace/folder'
        })
      ],
      repos: [
        ...repos,
        {
          id: 'runtime-in-folder',
          path: '/workspace/folder/repo',
          connectionId: null,
          executionHostId: 'runtime:devbox' as const
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder-runtime-candidate',
          projectGroupId: 'group-local',
          folderPath: '/workspace/folder'
        }
      ],
      projectGroups
    })
    expect(target.status).toBe('blocked')
    expect(target.status === 'blocked' ? target.message : '').toContain('runtime-hosted')
  })

  it('blocks folder workspaces when folder metadata is unavailable', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
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
      message: 'Open a local workspace before resuming a session.'
    })
  })

  it('blocks folder workspaces with mixed candidate repo hosts as unknown', () => {
    const target = resolveMobileAiVaultSessionResumeTarget({
      session: session({ cwd: '/Users/ada/mixed/src' }),
      activeWorktreeId: 'folder:folder-mixed',
      worktrees: [
        worktree({
          worktreeId: 'folder:folder-mixed',
          repoId: 'folder-workspace:group-local',
          workspaceKind: 'folder-workspace',
          path: '/Users/ada/mixed'
        })
      ],
      repos: [
        {
          id: 'local-in-folder',
          path: '/Users/ada/mixed/local',
          connectionId: null
        },
        {
          id: 'ssh-in-folder',
          path: '/Users/ada/mixed/ssh',
          connectionId: 'builder'
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder-mixed',
          projectGroupId: 'group-local',
          folderPath: '/Users/ada/mixed'
        }
      ],
      projectGroups
    })
    expect(target).toEqual({
      status: 'blocked',
      message: 'Open a local workspace before resuming a session.'
    })
  })
})
