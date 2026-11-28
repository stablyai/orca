import { describe, expect, it } from 'vitest'
import { answeredClaudeMove, type AskedClaudeMove } from './claude-host-account-switch'
import type { ClaudeHostFolders } from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'

const hostState: ClaudeHostFolders = {
  accounts: [
    {
      id: 'acct-a',
      displayName: 'Account A',
      email: 'a@example.com',
      home: '/tmp/claude-a',
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    },
    {
      id: 'acct-b',
      displayName: 'Account B',
      email: 'b@example.com',
      home: '/tmp/claude-b',
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    },
    {
      id: 'acct-c',
      displayName: 'Account C',
      email: 'c@example.com',
      home: '/tmp/claude-c',
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ]
}

describe('answeredClaudeMove', () => {
  it('rejects an older toast answer when a later switch lands on the same target account', () => {
    const latestAsk: AskedClaudeMove = {
      askId: '3',
      ptyIds: new Set(['pty-c1', 'pty-c2']),
      change: {
        target: { runtime: 'host' },
        before: { state: hostState, accountId: 'acct-c' },
        after: { state: hostState, accountId: 'acct-b' },
        runningSessions: 'ask'
      }
    }

    // Stale toast from an earlier A -> B switch (askId '1') clicks Restart after C -> B (askId '3').
    const staleReply = answeredClaudeMove(
      latestAsk,
      {
        target: { runtime: 'host' },
        before: { state: hostState, accountId: 'acct-a' },
        after: { state: hostState, accountId: 'acct-b' },
        runningSessions: 'restart',
        answersAskFor: 'acct-b',
        answersAskId: '1'
      },
      { ...hostState, activeAccountId: 'acct-b' }
    )
    expect(staleReply).toBeUndefined()

    // Matching toast (askId '3') answers the latest Ask and returns only its captured PTYs.
    const matchingReply = answeredClaudeMove(
      latestAsk,
      {
        target: { runtime: 'host' },
        before: { state: hostState, accountId: 'acct-c' },
        after: { state: hostState, accountId: 'acct-b' },
        runningSessions: 'restart',
        answersAskFor: 'acct-b',
        answersAskId: '3'
      },
      { ...hostState, activeAccountId: 'acct-b' }
    )
    expect(matchingReply?.change.before.accountId).toBe('acct-c')
    expect(matchingReply?.change.runningSessions).toBe('restart')
    expect([...(matchingReply?.ptyIds ?? [])]).toEqual(['pty-c1', 'pty-c2'])
  })
})
