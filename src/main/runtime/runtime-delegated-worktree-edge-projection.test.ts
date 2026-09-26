import { describe, expect, it } from 'vitest'
import { RuntimeDelegatedWorktreeEdgeProjection } from './runtime-delegated-worktree-edge-projection'

type Placement = {
  dispatch_id: string
  environment_id: string
  remote_worktree_id: string
  creator_handle: string | null
  creator_pane_key: string | null
}

function projection(args: {
  placements?: Placement[]
  worktreeByHandle?: Record<string, string>
  handleByPaneKey?: Record<string, string>
  db?: 'missing' | 'without-query' | 'throws'
}): RuntimeDelegatedWorktreeEdgeProjection {
  const db =
    args.db === 'missing'
      ? null
      : args.db === 'without-query'
        ? {}
        : args.db === 'throws'
          ? {
              listDelegatedWorktreePlacements: (): Placement[] => {
                throw new Error('SQLITE_BUSY: database is locked')
              }
            }
          : { listDelegatedWorktreePlacements: () => args.placements ?? [] }
  return new RuntimeDelegatedWorktreeEdgeProjection({
    getDb: () => db,
    getWorktreeId: (handle) => args.worktreeByHandle?.[handle] ?? null,
    getHandleForPaneKey: (paneKey) => args.handleByPaneKey?.[paneKey] ?? null
  })
}

const placement: Placement = {
  dispatch_id: 'ctx_1',
  environment_id: 'env-1',
  remote_worktree_id: 'repo-remote::/home/ubuntu/worker',
  creator_handle: 'term_coordinator',
  creator_pane_key: 'pane-1'
}

describe('RuntimeDelegatedWorktreeEdgeProjection', () => {
  // Runs inside every graph sync: a failing query must read as unknown, not fail the sync.
  it('reports a query that throws as unknown', () => {
    expect(projection({ db: 'throws' }).build()).toEqual({ known: false })
  })

  it('pairs the remote worktree with the coordinator terminal that dispatched it', () => {
    const edges = projection({
      placements: [placement],
      worktreeByHandle: { term_coordinator: 'repo-1::/home/alex/coordinator' }
    }).build()
    expect(edges).toEqual({
      known: true,
      edges: [
        {
          parentWorktreeId: 'repo-1::/home/alex/coordinator',
          childHostId: 'runtime:env-1',
          childWorktreeId: 'repo-remote::/home/ubuntu/worker',
          dispatchId: 'ctx_1'
        }
      ]
    })
  })

  it('falls back to the pane key when the handle was reminted by a restart', () => {
    const edges = projection({
      placements: [placement],
      handleByPaneKey: { 'pane-1': 'term_reminted' },
      worktreeByHandle: { term_reminted: 'repo-1::/home/alex/coordinator' }
    }).build()
    expect(edges.known && edges.edges[0]?.parentWorktreeId).toBe('repo-1::/home/alex/coordinator')
  })

  it('drops a placement whose coordinator terminal is gone', () => {
    expect(projection({ placements: [placement] }).build()).toEqual({ known: true, edges: [] })
  })

  it('keeps an edge whose coordinator and worker share a bare id on different hosts', () => {
    const edges = projection({
      placements: [placement],
      worktreeByHandle: { term_coordinator: placement.remote_worktree_id }
    }).build()
    expect(edges).toEqual({
      known: true,
      edges: [
        {
          parentWorktreeId: placement.remote_worktree_id,
          childHostId: 'runtime:env-1',
          childWorktreeId: placement.remote_worktree_id,
          dispatchId: 'ctx_1'
        }
      ]
    })
  })

  it('separates a db that cannot answer from a db that answers zero', () => {
    expect(projection({ db: 'missing' }).build()).toEqual({ known: false })
    expect(projection({ db: 'without-query' }).build()).toEqual({ known: false })
    expect(projection({ placements: [] }).build()).toEqual({ known: true, edges: [] })
  })
})
