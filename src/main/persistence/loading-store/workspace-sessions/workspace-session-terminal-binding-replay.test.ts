import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { preserveMissingWorkspaceSessionTerminalBindings } from './workspace-session-terminal-binding-replay'

const LEAF_ONE = '11111111-1111-4111-8111-111111111111'

const WORKTREE_A = 'worktree-a'
const WORKTREE_B = 'worktree-b'

function session(ptyId: string | null): WorkspaceSessionState {
  return {
    activeRepoId: 'repo',
    activeWorktreeId: 'worktree',
    activeTabId: 'tab',
    tabsByWorktree: {
      worktree: [
        {
          id: 'tab',
          worktreeId: 'worktree',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

function terminalTab(worktreeId: string, id: string, ptyId: string | null) {
  return {
    id,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ptyId
  }
}

const bindingRecovery = {
  getTerminalLayoutLeafIds: (root: { leafId?: string } | null) =>
    new Set(root?.leafId ? [root.leafId] : []),
  getConnectionIdForWorktree: () => null,
  isRestorablePtyBinding: () => true,
  hasRestorableSshRemotePtyLease: () => false
}

describe('workspace session terminal binding replay', () => {
  it('fails closed when one tab id is duplicated across worktrees', () => {
    const prior = session(null)
    prior.tabsByWorktree = {
      [WORKTREE_A]: [terminalTab(WORKTREE_A, 'duplicate-tab', 'pty-a')],
      [WORKTREE_B]: [terminalTab(WORKTREE_B, 'duplicate-tab', 'pty-b')]
    }
    prior.terminalLayoutsByTabId = {
      'duplicate-tab': {
        root: { type: 'leaf', leafId: LEAF_ONE },
        activeLeafId: LEAF_ONE,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ONE]: 'pty-a' }
      }
    }
    const incoming = session(null)
    incoming.tabsByWorktree = {
      [WORKTREE_A]: [terminalTab(WORKTREE_A, 'duplicate-tab', null)],
      [WORKTREE_B]: [terminalTab(WORKTREE_B, 'duplicate-tab', null)]
    }
    incoming.terminalLayoutsByTabId = {
      'duplicate-tab': {
        root: { type: 'leaf', leafId: LEAF_ONE },
        activeLeafId: LEAF_ONE,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }

    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)

    expect(incoming.tabsByWorktree[WORKTREE_A]![0]!.ptyId).toBeNull()
    expect(incoming.tabsByWorktree[WORKTREE_B]![0]!.ptyId).toBeNull()
    expect(incoming.terminalLayoutsByTabId['duplicate-tab']?.ptyIdsByLeafId).toEqual({})
  })
})
