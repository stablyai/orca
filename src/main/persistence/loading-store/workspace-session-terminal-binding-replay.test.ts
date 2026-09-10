import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { preserveMissingWorkspaceSessionTerminalBindings } from './workspace-session-terminal-binding-replay'

const LEAF_ONE = '11111111-1111-4111-8111-111111111111'
const LEAF_TWO = '22222222-2222-4222-8222-222222222222'
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
  it('retains a restorable legacy tab binding when neither snapshot has a layout', () => {
    const prior = session('runtime-pty')
    const incoming = session(null)

    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)

    expect(incoming.tabsByWorktree.worktree[0]!.ptyId).toBe('runtime-pty')
  })

  it('does not retain a tab binding whose prior leaf was removed from the layout', () => {
    const prior = session('runtime-pty')
    prior.terminalLayoutsByTabId.tab = {
      root: { type: 'leaf', leafId: LEAF_ONE },
      activeLeafId: LEAF_ONE,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ONE]: 'runtime-pty' }
    }
    const incoming = session(null)
    incoming.terminalLayoutsByTabId.tab = {
      root: { type: 'leaf', leafId: LEAF_TWO },
      activeLeafId: LEAF_TWO,
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }

    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)

    expect(incoming.tabsByWorktree.worktree[0]!.ptyId).toBeNull()
  })

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

  it('still replays bindings for distinct tab ids in separate worktrees', () => {
    const prior = session(null)
    prior.tabsByWorktree = {
      [WORKTREE_A]: [terminalTab(WORKTREE_A, 'tab-a', 'pty-a')],
      [WORKTREE_B]: [terminalTab(WORKTREE_B, 'tab-b', 'pty-b')]
    }
    prior.terminalLayoutsByTabId = {
      'tab-a': {
        root: { type: 'leaf', leafId: LEAF_ONE },
        activeLeafId: LEAF_ONE,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ONE]: 'pty-a' }
      },
      'tab-b': {
        root: { type: 'leaf', leafId: LEAF_TWO },
        activeLeafId: LEAF_TWO,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_TWO]: 'pty-b' }
      }
    }
    const incoming = session(null)
    incoming.tabsByWorktree = {
      [WORKTREE_A]: [terminalTab(WORKTREE_A, 'tab-a', null)],
      [WORKTREE_B]: [terminalTab(WORKTREE_B, 'tab-b', null)]
    }
    incoming.terminalLayoutsByTabId = {
      'tab-a': {
        root: { type: 'leaf', leafId: LEAF_ONE },
        activeLeafId: LEAF_ONE,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      },
      'tab-b': {
        root: { type: 'leaf', leafId: LEAF_TWO },
        activeLeafId: LEAF_TWO,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }

    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)

    expect(incoming.tabsByWorktree[WORKTREE_A]![0]!.ptyId).toBe('pty-a')
    expect(incoming.tabsByWorktree[WORKTREE_B]![0]!.ptyId).toBe('pty-b')
    expect(incoming.terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toEqual({
      [LEAF_ONE]: 'pty-a'
    })
    expect(incoming.terminalLayoutsByTabId['tab-b']?.ptyIdsByLeafId).toEqual({
      [LEAF_TWO]: 'pty-b'
    })
  })

  it('fails closed when one tab id is duplicated inside a single worktree list', () => {
    // Map indexing is last-wins where a linear find was first-wins; the ambiguity
    // fence must skip these ids so the two strategies can never disagree.
    const prior = session(null)
    prior.tabsByWorktree = {
      [WORKTREE_A]: [
        terminalTab(WORKTREE_A, 'duplicate-tab', 'pty-first'),
        terminalTab(WORKTREE_A, 'duplicate-tab', 'pty-last')
      ]
    }
    const incoming = session(null)
    incoming.tabsByWorktree = {
      [WORKTREE_A]: [terminalTab(WORKTREE_A, 'duplicate-tab', null)]
    }

    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)

    expect(incoming.tabsByWorktree[WORKTREE_A]![0]!.ptyId).toBeNull()
  })

  it('indexes prior tabs once when replaying a large workspace snapshot', () => {
    let reads = 0
    const prior = session(null)
    prior.tabsByWorktree.worktree = Array.from({ length: 1000 }, (_, i) => ({
      ...terminalTab('worktree', `tab-${i}`, `pty-${i}`),
      get id() {
        reads++
        return `tab-${i}`
      }
    }))
    const incoming = session(null)
    incoming.tabsByWorktree.worktree = Array.from({ length: 1000 }, (_, i) =>
      terminalTab('worktree', `tab-${i}`, null)
    )
    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, bindingRecovery as never)
    expect(reads).toBeLessThan(10_000)
    expect(incoming.tabsByWorktree.worktree.map((tab) => tab.ptyId)).toEqual(
      Array.from({ length: 1000 }, (_, i) => `pty-${i}`)
    )
  })
})
