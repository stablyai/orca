import { expect, it } from 'vitest'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type { MembershipRewrites } from './workspace-session-membership-rewrites'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

it('reports the worktree whose stale group history a rebase repairs, and not the ones it rebuilt unchanged', () => {
  let stored = emptySession()
  for (const [index, key] of ['repo-1::/j', 'repo-1::/k'].entries()) {
    stored = addWorkspace(stored, key, [
      { id: `group-${index}`, tabs: [{ id: `tab-${index}`, leaves: [[leaf(index + 1)]] }] }
    ])
  }
  const [group] = stored.tabGroups?.['repo-1::/j'] ?? []
  stored = {
    ...stored,
    terminalTopologyRevisionByRepoId: { 'repo-1': 1 },
    tabGroups: {
      ...stored.tabGroups,
      'repo-1::/j': [{ ...group!, recentTabIds: ['gone', 'tab-0'] }]
    }
  }
  const rewrites: MembershipRewrites = { worktreeIds: new Set(), tabIds: new Set(), whole: false }

  const rebased = rebaseWorkspaceSessionTerminalMembership({ ...stored }, stored, rewrites)

  expect(rebased.tabGroups?.['repo-1::/j']?.[0]?.recentTabIds).toEqual(['tab-0'])
  expect(rewrites).toEqual({
    worktreeIds: new Set(['repo-1::/j']),
    tabIds: new Set(),
    whole: false
  })
})
