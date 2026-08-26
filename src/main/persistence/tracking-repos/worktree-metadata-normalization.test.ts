import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeWorktreeLinkedItemMetadata } from './worktree-metadata-normalization'

// Only the presence of an entry matters here; the normalizer never reads its linked-item fields.
function makeMeta(): WorktreeMeta {
  return { createdAt: 1 } as WorktreeMeta
}

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return {
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  } as PersistedState
}

describe('normalizeWorktreeLinkedItemMetadata', () => {
  it('reports a null lineage map repair as changed so the load path re-saves it', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() },
      worktreeLineageById: null as unknown as PersistedState['worktreeLineageById']
    })

    // Without this the map stays null on disk and is repaired again on every reload.
    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeLineageById).toEqual({})
  })

  it('reports a null child-key lineage map repair as changed', () => {
    const state = makeState({
      worktreeMeta: {},
      workspaceLineageByChildKey: null as unknown as PersistedState['workspaceLineageByChildKey']
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.workspaceLineageByChildKey).toEqual({})
  })

  it('leaves already-normalized state clean', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(false)
  })
})
