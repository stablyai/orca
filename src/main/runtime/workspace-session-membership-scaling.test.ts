import { expect, it, vi } from 'vitest'
import type { TabGroup } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

it('rebases a large group without rescanning tab order for every recent tab', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `tab-${index}`)
  const session: WorkspaceSessionState = {
    activeRepoId: 'repo',
    activeWorktreeId: 'repo::/workspace',
    activeTabId: null,
    tabsByWorktree: {
      'repo::/workspace': ids.map((id, index) => ({
        id,
        worktreeId: 'repo::/workspace',
        ptyId: null,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 0
      }))
    },
    terminalLayoutsByTabId: {},
    terminalTopologyRevisionByRepoId: { repo: 1 },
    tabGroups: {
      'repo::/workspace': [
        {
          id: 'group',
          worktreeId: 'repo::/workspace',
          activeTabId: 'missing',
          tabOrder: [...ids, 'missing'],
          recentTabIds: [...ids, 'missing']
        }
      ]
    }
  }
  const includes = vi.spyOn(Array.prototype, 'includes')
  let result: WorkspaceSessionState
  let probes: number
  try {
    result = rebaseWorkspaceSessionTerminalMembership(session, session)
    probes = includes.mock.calls.length
  } finally {
    includes.mockRestore()
  }
  expect(probes).toBeLessThan(10)
  expect(result.tabGroups?.['repo::/workspace'][0]).toMatchObject({
    tabOrder: ids,
    recentTabIds: ids,
    activeTabId: ids[0]
  })
})

// Why: the rebased session is the host-authoritative one, so a tab id the host no
// longer has must not survive into it. `activeTabId` already failed closed; the
// filtered `recentTabIds` used to be dropped when it emptied, letting the `...group`
// spread put the unfiltered array back.
it('drops tab ids the host no longer has from group membership, failing closed', () => {
  const buildSession = (
    activeTabId: string | null,
    recentTabIds: string[] | undefined
  ): WorkspaceSessionState =>
    ({
      activeRepoId: 'repo',
      activeWorktreeId: 'repo::/workspace',
      activeTabId: null,
      tabsByWorktree: {
        'repo::/workspace': ['kept-a', 'kept-b'].map((id, index) => ({
          id,
          worktreeId: 'repo::/workspace',
          ptyId: null,
          title: id,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: 0
        }))
      },
      terminalLayoutsByTabId: {},
      terminalTopologyRevisionByRepoId: { repo: 1 },
      tabGroups: {
        'repo::/workspace': [
          {
            id: 'group',
            worktreeId: 'repo::/workspace',
            activeTabId,
            tabOrder: ['kept-a', 'closed-on-host', 'kept-b'],
            ...(recentTabIds ? { recentTabIds } : {})
          }
        ]
      }
    }) as WorkspaceSessionState

  const rebase = (
    activeTabId: string | null,
    recentTabIds: string[] | undefined
  ): TabGroup | undefined => {
    const session = buildSession(activeTabId, recentTabIds)
    return rebaseWorkspaceSessionTerminalMembership(session, session).tabGroups?.[
      'repo::/workspace'
    ][0]
  }

  // Every recent id is stale: the array must empty, not revert to the stale one.
  expect(rebase('kept-b', ['closed-on-host'])).toMatchObject({
    tabOrder: ['kept-a', 'kept-b'],
    activeTabId: 'kept-b',
    recentTabIds: []
  })
  // Mixed: only the host-known ids survive, in order.
  expect(rebase('kept-a', ['closed-on-host', 'kept-b', 'closed-on-host', 'kept-a'])).toMatchObject({
    recentTabIds: ['kept-b', 'kept-a']
  })
  // A stale active tab falls back to the first surviving tab, never to the stale id.
  expect(rebase('closed-on-host', ['kept-a'])).toMatchObject({
    activeTabId: 'kept-a',
    recentTabIds: ['kept-a']
  })
  expect(rebase(null, undefined)).toMatchObject({ activeTabId: 'kept-a' })
  // A group that never carried recentTabIds must not gain the key.
  expect(rebase('kept-a', undefined)).not.toHaveProperty('recentTabIds')
})
