import { describe, expect, it } from 'vitest'
import { resolveProjectClaudeAccount } from './project-claude-account-resolution'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../shared/claude/project-claude-account-preference'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'

const worktreeId = getRepoMainWorktreeId({ id: 'repo-1', path: '/w/app' })
const repo = (agentAccounts?: Repo['agentAccounts']): Repo | undefined =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolver only reads agentAccounts.
  ({ id: 'repo-1', agentAccounts }) as Repo

describe('resolveProjectClaudeAccount', () => {
  it('prefers explicit, then launch config, then the saved project account', () => {
    const getRepo = () => repo({ claude: { mode: 'account', accountId: 'saved' } })
    expect(resolveProjectClaudeAccount({ getRepo, worktreeId, explicitAccountId: 'cli' })).toBe(
      'cli'
    )
    expect(
      resolveProjectClaudeAccount({ getRepo, worktreeId, launchConfigAccountId: 'resume' })
    ).toBe('resume')
    expect(resolveProjectClaudeAccount({ getRepo, worktreeId })).toBe('saved')
  })

  it('keeps the active sentinel unpinned even when the project has an account', () => {
    const getRepo = () => repo({ claude: { mode: 'account', accountId: 'saved' } })
    expect(
      resolveProjectClaudeAccount({
        getRepo,
        worktreeId,
        launchConfigAccountId: ACTIVE_CLAUDE_ACCOUNT
      })
    ).toBeUndefined()
  })

  it('returns nothing for ask, no preference, or unknown repos', () => {
    expect(
      resolveProjectClaudeAccount({ getRepo: () => repo({ claude: { mode: 'ask' } }), worktreeId })
    ).toBeUndefined()
    expect(resolveProjectClaudeAccount({ getRepo: () => repo(), worktreeId })).toBeUndefined()
    expect(resolveProjectClaudeAccount({ getRepo: () => undefined, worktreeId })).toBeUndefined()
    expect(
      resolveProjectClaudeAccount({ getRepo: () => repo(), worktreeId: undefined })
    ).toBeUndefined()
  })
})
