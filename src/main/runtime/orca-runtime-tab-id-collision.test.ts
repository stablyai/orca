import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'

const WORKTREE_A = 'repo-1::/tmp/worktree-a'
const WORKTREE_B = 'repo-1::/tmp/worktree-b'

function tab(tabId: string, worktreeId: string) {
  return {
    tabId,
    worktreeId,
    title: `${worktreeId} tab`,
    activeLeafId: null,
    layout: null
  }
}

function graph(tabs: RuntimeSyncWindowGraph['tabs']): RuntimeSyncWindowGraph {
  return { tabs, leaves: [] }
}

describe('runtime graph tab identity', () => {
  it('does not claim graph authority when the first publication is malformed', () => {
    const runtime = new OrcaRuntimeService()

    expect(() =>
      runtime.syncWindowGraph(
        1,
        graph([tab('tab-duplicate', WORKTREE_A), tab('tab-duplicate', WORKTREE_B)])
      )
    ).toThrow('duplicate_runtime_tab_id')
    expect(
      (runtime as unknown as { authoritativeWindowId: number | null }).authoritativeWindowId
    ).toBe(null)

    expect(() => runtime.syncWindowGraph(1, graph([tab('tab-valid', WORKTREE_A)]))).not.toThrow()
  })

  it('rejects duplicate tab ids across worktrees before replacing the graph', () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, graph([tab('tab-unique', WORKTREE_A)]))

    expect(() =>
      runtime.syncWindowGraph(
        1,
        graph([tab('tab-duplicate', WORKTREE_A), tab('tab-duplicate', WORKTREE_B)])
      )
    ).toThrow('duplicate_runtime_tab_id')

    expect([...(runtime as unknown as { tabs: Map<string, unknown> }).tabs.keys()]).toEqual([
      'tab-unique'
    ])
  })

  it('accepts distinct tab ids from different worktrees', () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)

    expect(() =>
      runtime.syncWindowGraph(1, graph([tab('tab-a', WORKTREE_A), tab('tab-b', WORKTREE_B)]))
    ).not.toThrow()
    expect([...(runtime as unknown as { tabs: Map<string, unknown> }).tabs.keys()]).toEqual([
      'tab-a',
      'tab-b'
    ])
  })
})
