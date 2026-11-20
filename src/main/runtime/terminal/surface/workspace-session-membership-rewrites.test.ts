import { expect, it } from 'vitest'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type { MembershipRewrites } from './workspace-session-membership-rewrites'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

it('repairs stale group tabs and reports only the changed worktree', () => {
  const repaired = 'repo-1::/j'
  const unchanged = 'repo-1::/k'
  let stored = addWorkspace(emptySession(), repaired, [
    {
      id: 'primary',
      tabs: [
        { id: 'a', leaves: [[leaf(1)]] },
        { id: 'b', leaves: [[leaf(2)]] }
      ]
    },
    {
      id: 'secondary',
      tabs: [
        { id: 'c', leaves: [[leaf(3)]] },
        { id: 'd', leaves: [[leaf(4)]] }
      ]
    }
  ])
  stored = addWorkspace(stored, unchanged, [
    { id: 'other', tabs: [{ id: 'e', leaves: [[leaf(5)]] }] }
  ])
  const [primary, secondary] = stored.tabGroups?.[repaired] ?? []
  stored = {
    ...stored,
    terminalTopologyRevisionByRepoId: { 'repo-1': 1 },
    tabGroups: {
      ...stored.tabGroups,
      [repaired]: [
        {
          ...primary!,
          activeTabId: 'gone',
          tabOrder: ['a', 'gone', 'b'],
          recentTabIds: ['gone']
        },
        {
          ...secondary!,
          activeTabId: 'd',
          recentTabIds: ['gone', 'd', 'gone', 'c']
        }
      ]
    }
  }
  const rewrites: MembershipRewrites = { worktreeIds: new Set(), tabIds: new Set(), whole: false }

  const rebased = rebaseWorkspaceSessionTerminalMembership({ ...stored }, stored, rewrites)

  expect(rebased.tabGroups?.[repaired]).toMatchObject([
    { tabOrder: ['a', 'b'], activeTabId: 'a', recentTabIds: [] },
    { tabOrder: ['c', 'd'], activeTabId: 'd', recentTabIds: ['d', 'c'] }
  ])
  expect(rebased.tabGroups?.[unchanged]?.[0]).not.toHaveProperty('recentTabIds')
  expect(rewrites).toEqual({
    worktreeIds: new Set([repaired]),
    tabIds: new Set(),
    whole: false
  })
})
