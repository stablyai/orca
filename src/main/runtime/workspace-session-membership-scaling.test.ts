import { expect, it } from 'vitest'
import type { TabGroup } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

// An empty filtered recentTabIds must remain explicit or the group spread restores stale host-dropped ids.
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

  expect(rebase('kept-b', ['closed-on-host'])).toMatchObject({
    tabOrder: ['kept-a', 'kept-b'],
    activeTabId: 'kept-b',
    recentTabIds: []
  })
  expect(rebase('kept-a', ['closed-on-host', 'kept-b', 'closed-on-host', 'kept-a'])).toMatchObject({
    recentTabIds: ['kept-b', 'kept-a']
  })
  expect(rebase('closed-on-host', ['kept-a'])).toMatchObject({
    activeTabId: 'kept-a',
    recentTabIds: ['kept-a']
  })
  expect(rebase(null, undefined)).toMatchObject({ activeTabId: 'kept-a' })
  expect(rebase('kept-a', undefined)).not.toHaveProperty('recentTabIds')
})
