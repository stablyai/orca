import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/metadata/meta-persisted-defaults'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { normalizeWorktreeLinkedItemMetadata } from './worktree-metadata-normalization'

// Surviving rows must restore the defaults omitted by serialization.
function makeMeta(): WorktreeMeta {
  return { createdAt: 1, ...WORKTREE_META_PERSISTED_DEFAULTS } as WorktreeMeta
}

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return {
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  } as PersistedState
}

describe('normalizeWorktreeLinkedItemMetadata plugin task links', () => {
  it('clears every invalid plugin task link, falsy ones included', () => {
    const link = {
      pluginKey: 'orca-samples.hello-tasks',
      sourceId: 'samples',
      itemId: 'a',
      title: 'A',
      sourceTitle: 'Hello Tasks'
    }
    const state = makeState({
      worktreeMeta: {
        'r1::/tmp/empty': Object.assign(makeMeta(), { linkedPluginTask: '' }),
        'r1::/tmp/zero': Object.assign(makeMeta(), { linkedPluginTask: 0 }),
        'r1::/tmp/partial': Object.assign(makeMeta(), { linkedPluginTask: { itemId: 'a' } }),
        'r1::/tmp/valid': { ...makeMeta(), linkedPluginTask: link }
      }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMeta['r1::/tmp/empty']?.linkedPluginTask).toBeNull()
    expect(state.worktreeMeta['r1::/tmp/zero']?.linkedPluginTask).toBeNull()
    expect(state.worktreeMeta['r1::/tmp/partial']?.linkedPluginTask).toBeNull()
    expect(state.worktreeMeta['r1::/tmp/valid']?.linkedPluginTask).toEqual(link)
  })
})
