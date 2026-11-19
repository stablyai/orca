import { expect, it } from 'vitest'
import { loadMobileHistoryHandoffAgents } from './mobile-history-handoff-agents'
import { historyClient, historySession } from './mobile-history-test-fixture'

it('detects agents for the refreshed recorded workspace when two workspaces share a path', async () => {
  const old = historySession({
    structuredSession: { sessionId: 'owner', workspaceId: 'repo::/old' }
  })
  const fresh = { ...old, structuredSession: { sessionId: 'owner', workspaceId: 'repo::/new' } }
  const client = historyClient(fresh, async (method, params) => {
    if (method === 'worktree.ps') {
      return {
        id: 'reply',
        ok: true,
        result: {
          worktrees: [
            { worktreeId: 'repo::/old', repoId: 'repo', path: '/repo' },
            { worktreeId: 'repo::/new', repoId: 'repo', path: '/repo' }
          ]
        }
      }
    }
    if (method === 'preflight.detectAgents') {
      expect(params).toEqual({ worktreeId: 'repo::/new' })
      return { id: 'reply', ok: true, result: ['codex'] }
    }
  })
  const choices = await loadMobileHistoryHandoffAgents({
    client,
    session: old,
    worktreeId: 'repo::/old',
    worktrees: [],
    assertCurrentOwner: () => {}
  })
  expect(choices.worktreeId).toBe('repo::/new')
  expect(choices.agents.map((row) => row.agent)).toEqual(['codex'])
})
