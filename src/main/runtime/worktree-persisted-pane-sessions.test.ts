import { describe, expect, it } from 'vitest'
import { persistedPaneSessionIdsForWorktree } from './worktree-persisted-pane-sessions'

describe('persistedPaneSessionIdsForWorktree', () => {
  it('collects every saved pane binding of the worktree, and only of that worktree', () => {
    const session = {
      tabsByWorktree: {
        'repo::/a': [
          { id: 't1', worktreeId: 'repo::/a', ptyId: 'repo::/a@@one' },
          { id: 't2', worktreeId: 'repo::/a', ptyId: null }
        ],
        'repo::/b': [{ id: 't3', worktreeId: 'repo::/b', ptyId: 'repo::/b@@three' }]
      },
      terminalLayoutsByTabId: {
        t1: { ptyIdsByLeafId: { l1: 'repo::/a@@one', l2: 'repo::/a@@split' } },
        t2: { ptyIdsByLeafId: { l3: 'repo::/a@@restored' } },
        t3: { ptyIdsByLeafId: { l4: 'repo::/b@@three' } }
      }
    }

    expect(
      persistedPaneSessionIdsForWorktree(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader uses only tab id, worktreeId, ptyId and layout ptyIdsByLeafId.
        session as unknown as Parameters<typeof persistedPaneSessionIdsForWorktree>[0],
        'repo::/a'
      ).sort()
    ).toEqual(['repo::/a@@one', 'repo::/a@@restored', 'repo::/a@@split'])
    expect(persistedPaneSessionIdsForWorktree(null, 'repo::/a')).toEqual([])
  })
})
