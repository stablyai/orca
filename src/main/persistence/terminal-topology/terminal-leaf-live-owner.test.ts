import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { findLiveLeafOwnerTabId } from './terminal-leaf-live-owner'

const WT = 'repo-1::/tmp/wt'
const LEAF = '11111111-1111-4111-8111-111111111111'

function session(tabIds: string[], layoutTabIds: string[]): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: tabIds[0] ?? null,
    tabsByWorktree: {
      [WT]: tabIds.map((id) => ({
        id,
        ptyId: null,
        worktreeId: WT,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      layoutTabIds.map((id) => [
        id,
        { root: { type: 'leaf' as const, leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
      ])
    )
  }
}

describe('findLiveLeafOwnerTabId', () => {
  it('finds the one live tab that holds the leaf when the named tab does not', () => {
    expect(findLiveLeafOwnerTabId([session(['tab-b'], ['tab-b'])], 'tab-a', LEAF)).toBe('tab-b')
  })

  it('keeps the named tab while it still holds the leaf', () => {
    expect(
      findLiveLeafOwnerTabId([session(['tab-a', 'tab-b'], ['tab-a', 'tab-b'])], 'tab-a', LEAF)
    ).toBe('tab-a')
  })

  it('ignores a layout whose tab row was removed', () => {
    expect(findLiveLeafOwnerTabId([session(['tab-c'], ['tab-b'])], 'tab-a', LEAF)).toBeNull()
  })

  it('answers null when several live tabs claim the leaf', () => {
    expect(
      findLiveLeafOwnerTabId([session(['tab-b', 'tab-c'], ['tab-b', 'tab-c'])], 'tab-a', LEAF)
    ).toBeNull()
  })

  it('searches every partition', () => {
    expect(
      findLiveLeafOwnerTabId([session([], []), session(['tab-b'], ['tab-b'])], 'tab-a', LEAF)
    ).toBe('tab-b')
  })
})
