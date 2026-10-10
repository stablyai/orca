import { describe, expect, it } from 'vitest'
import { resolveMobileAiVaultSessionResumeTarget } from './agent-history-resume-target'
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

  describe('SSH workspaces', () => {
    const sshRepos = [
      ...repos,
      { id: 'other-ssh-repo', path: '/home/ada/other', connectionId: 'other-builder' }
    ]
    const sshWorktree = worktree({
      worktreeId: 'ssh-wt',
      repoId: 'ssh-repo',
      path: '/home/ada/ssh-repo/feature'
    })
    const resolve = (sessionOverrides: Partial<AiVaultSession>, worktrees = [sshWorktree]) =>
      resolveMobileAiVaultSessionResumeTarget({
        session: session({ cwd: '/home/ada/ssh-repo/feature/src', ...sessionOverrides }),
        activeWorktreeId: 'ssh-wt',
        worktrees,
        repos: sshRepos
      })

    it('resumes a session stored on the same SSH host', () => {
      expect(
        resolve({ executionHostId: 'ssh:builder', filePath: '/home/ada/.claude/session.jsonl' })
      ).toEqual({
        status: 'ready',
        worktreeId: 'ssh-wt',
        targetStatus: 'ssh',
        workspacePath: '/home/ada/ssh-repo/feature',
        terminalPlatform: null
      })
    })

    it('matches the worktree host id before the repo connection', () => {
      const target = resolve({ executionHostId: 'ssh:builder' }, [
        { ...sshWorktree, hostId: 'ssh:builder' }
      ])
      expect(target.status).toBe('ready')
    })

    it('resumes a WSL-stored session into an SSH workspace (SSH-to-local-WSL)', () => {
      const target = resolve({
        executionHostId: 'local',
        filePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\s.jsonl'
      })
      expect(target.status).toBe('ready')
      expect(target.status === 'ready' ? target.targetStatus : '').toBe('ssh')
      // The WSL guess is the only proof here, so the caller must verify it on the SSH host.
      expect(target.status === 'ready' ? target.transcriptProbeHostId : '').toBe('ssh:builder')
    })

    describe('same-path SSH workspaces on different hosts', () => {
      const WSL_FILE = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\s.jsonl'
      const hostRepos = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
        id: `repo-${name}`,
        path: '/home/e2e/repo',
        connectionId: `host-${name}`
      }))
      const tied = hostRepos.map((repo) =>
        worktree({ worktreeId: `wt-${repo.id}`, repoId: repo.id, path: '/home/e2e/repo' })
      )
      const resolveTie = (worktrees: Worktree[], overrides: Partial<AiVaultSession> = {}) =>
        resolveMobileAiVaultSessionResumeTarget({
          session: session({ cwd: '/home/e2e/repo/src', filePath: WSL_FILE, ...overrides }),
          activeWorktreeId: null,
          worktrees,
          repos: hostRepos
        })

      it('returns one candidate per host in list order, capped at four', () => {
        const target = resolveTie(tied)
        expect(target.status === 'ready' ? target.worktreeId : '').toBe('wt-repo-a')
        expect(
          target.status === 'ready'
            ? target.transcriptProbeCandidates?.map((candidate) => candidate.transcriptProbeHostId)
            : null
        ).toEqual(['ssh:host-a', 'ssh:host-b', 'ssh:host-c', 'ssh:host-d'])
      })

      it('collapses same-host ties and skips archived workspaces', () => {
        const target = resolveTie([
          tied[0],
          worktree({ worktreeId: 'wt-a2', repoId: 'repo-a', path: '/home/e2e/repo' }),
          { ...tied[1], isArchived: true },
          tied[2]
        ])
        expect(
          target.status === 'ready'
            ? target.transcriptProbeCandidates?.map((candidate) => candidate.worktreeId)
            : null
        ).toEqual(['wt-repo-a', 'wt-repo-c'])
      })

      it('keeps a single target when the path match is not a tie', () => {
        const target = resolveTie([
          tied[0],
          worktree({ worktreeId: 'deeper', repoId: 'repo-b', path: '/home/e2e/repo/src' })
        ])
        expect(target.status === 'ready' ? target.worktreeId : '').toBe('deeper')
        expect(target.status === 'ready' ? target.transcriptProbeCandidates : 'x').toBeUndefined()
      })

      it('keeps a single target when only one host matches', () => {
        const target = resolveTie([tied[0]])
        expect(target.status === 'ready' ? target.transcriptProbeCandidates : 'x').toBeUndefined()
      })

      it('does not expand ties for rows that are not the WSL fallback', () => {
        const target = resolveTie(tied, {
          executionHostId: 'ssh:host-a',
          filePath: '/home/ada/.claude/session.jsonl'
        })
        expect(target.status === 'ready' ? target.transcriptProbeCandidates : 'x').toBeUndefined()
        expect(target.status === 'ready' ? target.transcriptProbeHostId : 'x').toBeUndefined()
      })
    })

    it('does not ask for a transcript probe when the row was scanned on the SSH host', () => {
      const target = resolve({
        executionHostId: 'ssh:builder',
        filePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\s.jsonl'
      })
      expect(target.status === 'ready' ? target.transcriptProbeHostId : 'blocked').toBeUndefined()
    })

    it('blocks a host-local session on an SSH workspace', () => {
      const target = resolve({ executionHostId: 'local' })
      expect(target.status).toBe('blocked')
      expect(target.status === 'blocked' ? target.message : '').toContain('SSH workspace')
    })

    it('blocks a session stored on a different SSH host', () => {
      const target = resolve({
        executionHostId: 'ssh:other-builder',
        filePath: '/home/ada/.claude/session.jsonl'
      })
      expect(target.status).toBe('blocked')
      expect(target.status === 'blocked' ? target.message : '').toContain('different SSH host')
    })

    it('blocks Antigravity IDE history on an SSH workspace even from the same host', () => {
      const target = resolve({
        executionHostId: 'ssh:builder',
        agent: 'antigravity',
        filePath: '/home/ada/.gemini/antigravity-ide/brain/abc/transcript.jsonl'
      })
      expect(target.status).toBe('blocked')
    })

    it('keeps runtime targets blocked even when the session host matches', () => {
      const target = resolveMobileAiVaultSessionResumeTarget({
        session: session({ cwd: '/workspace/runtime/app', executionHostId: 'runtime:devbox' }),
        activeWorktreeId: 'runtime-wt',
        worktrees: [
          worktree({ worktreeId: 'runtime-wt', repoId: 'runtime-repo', path: '/workspace/runtime' })
        ],
        repos
      })
      expect(target.status).toBe('blocked')
      expect(target.status === 'blocked' ? target.message : '').toContain('runtime-hosted')
    })
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
