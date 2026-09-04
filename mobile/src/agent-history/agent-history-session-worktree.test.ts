import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree
} from './agent-history-session-worktree'

function session(
  cwd: string | null,
  executionHostId: AiVaultSession['executionHostId'] = 'local'
): Pick<AiVaultSession, 'cwd' | 'executionHostId'> {
  return { cwd, executionHostId }
}

function worktree(overrides: Partial<Worktree> & { worktreeId: string; path: string }): Worktree {
  return {
    repoId: 'repo-1',
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

describe('resolveMobileAgentHistorySessionWorktree', () => {
  it('matches the active worktree when session cwd is inside it', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/Users/ada/repo/app/src'),
      worktrees: [worktree({ worktreeId: 'wt-1', path: '/Users/ada/repo/app' })],
      activeWorktreeId: 'wt-1'
    })
    expect(resolved).toMatchObject({ status: 'current', worktreeId: 'wt-1' })
  })

  it('prefers the longest active path match', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/Users/ada/repo/app/packages/mobile'),
      worktrees: [
        worktree({ worktreeId: 'root', path: '/Users/ada/repo' }),
        worktree({ worktreeId: 'app', path: '/Users/ada/repo/app' })
      ],
      activeWorktreeId: 'root'
    })
    expect(resolved).toMatchObject({ status: 'active', worktreeId: 'app' })
  })

  it('marks archived worktrees as unavailable for resume', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/Users/ada/repo/app'),
      worktrees: [
        worktree({ worktreeId: 'archived', path: '/Users/ada/repo/app', isArchived: true })
      ],
      activeWorktreeId: 'other'
    })
    expect(resolved).toMatchObject({ status: 'archived', worktreeId: 'archived' })
    expect(canResumeInMobileSessionWorktree(resolved)).toBe(false)
  })

  it('returns null when the session cwd has no active worktree match', () => {
    expect(
      resolveMobileAgentHistorySessionWorktree({
        session: session('/Users/ada/missing'),
        worktrees: [worktree({ worktreeId: 'wt-1', path: '/Users/ada/repo/app' })],
        activeWorktreeId: 'wt-1'
      })
    ).toBeNull()
  })

  it('matches a Windows drive worktree against a WSL /mnt/c transcript cwd', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/mnt/c/Users/neil/orca/orca'),
      worktrees: [
        worktree({
          worktreeId: 'win-wsl',
          path: String.raw`C:\Users\neil\orca\orca`
        })
      ],
      activeWorktreeId: 'win-wsl'
    })
    expect(resolved).toMatchObject({ status: 'current', worktreeId: 'win-wsl' })
  })

  it('does not attribute a local WSL session to a same-path SSH worktree', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/mnt/c/Users/neil/orca/orca/src'),
      worktrees: [
        worktree({
          worktreeId: 'ssh-mount',
          path: '/mnt/c/Users/neil/orca/orca',
          hostId: 'ssh:builder'
        }),
        worktree({
          worktreeId: 'local-drive',
          path: String.raw`C:\Users\neil\orca\orca`,
          hostId: 'local'
        })
      ],
      activeWorktreeId: 'ssh-mount'
    })

    expect(resolved).toMatchObject({ status: 'active', worktreeId: 'local-drive' })
  })

  it('prefers the deepest worktree independently of its WSL alias spelling', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/mnt/c/Users/neil/orca/app/src'),
      worktrees: [
        worktree({
          worktreeId: 'parent',
          path: String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`
        }),
        worktree({
          worktreeId: 'nested',
          path: String.raw`C:\Users\neil\orca\app`
        })
      ],
      activeWorktreeId: 'parent'
    })

    expect(resolved).toMatchObject({ status: 'active', worktreeId: 'nested' })
  })

  it('prefers a drive-root folder workspace over its POSIX /mnt parent', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/mnt/c/repo'),
      worktrees: [
        worktree({ worktreeId: 'mount-parent', path: '/mnt' }),
        worktree({
          worktreeId: 'folder-drive-root',
          path: 'C:\\',
          workspaceKind: 'folder-workspace'
        })
      ],
      activeWorktreeId: 'mount-parent'
    })

    expect(resolved).toMatchObject({ status: 'active', worktreeId: 'folder-drive-root' })
  })

  it('matches WSL UNC worktree paths against Linux transcript paths', () => {
    const resolved = resolveMobileAgentHistorySessionWorktree({
      session: session('/home/ada/repo/app'),
      worktrees: [
        worktree({
          worktreeId: 'wsl',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
        })
      ],
      activeWorktreeId: 'wsl'
    })
    expect(resolved).toMatchObject({ status: 'current', worktreeId: 'wsl' })
  })
})
