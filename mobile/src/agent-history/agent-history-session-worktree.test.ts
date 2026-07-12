import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree
} from './agent-history-session-worktree'

function session(cwd: string | null): Pick<AiVaultSession, 'cwd'> {
  return { cwd }
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
