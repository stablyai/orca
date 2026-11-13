import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/meta-persisted-defaults'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  gcStaleWorktreeMeta,
  normalizeWorktreeLinkedItemMetadata,
  WORKTREE_META_GC_GRACE_MS
} from './worktree-metadata-normalization'

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

describe('normalizeWorktreeLinkedItemMetadata', () => {
  it('drops malformed canonical metadata entries', () => {
    const state = makeState({
      worktreeMetaByIdentity: {
        valid: makeMeta(),
        malformed: null
      } as unknown as PersistedState['worktreeMetaByIdentity'],
      worktreeIdentityAliases: { 'local|r1::/tmp/wt': ['valid', 'malformed'] }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMetaByIdentity).toEqual({ valid: makeMeta() })
    expect(state.worktreeIdentityAliases).toEqual({ 'local|r1::/tmp/wt': ['valid'] })
  })

  it('preserves every host canonical row when one legacy locator row is malformed', () => {
    const localKey = 'wt2:local:local-instance'
    const remoteKey = 'wt2:ssh%3Abuilder:remote-instance'
    const worktreeId = 'r1::/tmp/wt'
    const state = makeState({
      worktreeMeta: { [worktreeId]: null } as unknown as PersistedState['worktreeMeta'],
      worktreeMetaByIdentity: { [localKey]: makeMeta(), [remoteKey]: makeMeta() },
      worktreeIdentityAliases: {
        [`local|${worktreeId}`]: [localKey],
        [`ssh:builder|${worktreeId}`]: [remoteKey]
      }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMeta).toEqual({})
    expect(state.worktreeMetaByIdentity).toEqual({
      [localKey]: makeMeta(),
      [remoteKey]: makeMeta()
    })
    expect(state.worktreeIdentityAliases).toEqual({
      [`local|${worktreeId}`]: [localKey],
      [`ssh:builder|${worktreeId}`]: [remoteKey]
    })
  })

  it('preserves valid canonical state when the whole legacy projection is malformed', () => {
    const identityKey = 'wt2:ssh%3Abuilder:remote-instance'
    const alias = 'ssh:builder|r1::/tmp/wt'
    const state = makeState({
      worktreeMeta: null as unknown as PersistedState['worktreeMeta'],
      worktreeMetaByIdentity: { [identityKey]: makeMeta() },
      worktreeIdentityAliases: { [alias]: [identityKey] }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMeta).toEqual({})
    expect(state.worktreeMetaByIdentity).toEqual({ [identityKey]: makeMeta() })
    expect(state.worktreeIdentityAliases).toEqual({ [alias]: [identityKey] })
  })

  it('prunes canonical metadata left unreachable by dangling-alias cleanup', () => {
    const liveKey = 'wt2:local:live'
    const orphanKey = 'wt2:local:orphan'
    const state = makeState({
      worktreeMetaByIdentity: { [liveKey]: makeMeta(), [orphanKey]: makeMeta() },
      worktreeIdentityAliases: {
        'local|r1::/tmp/live': [liveKey],
        'local|r1::/tmp/dangling': ['missing-key']
      }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMetaByIdentity).toEqual({ [liveKey]: makeMeta() })
    expect(state.worktreeIdentityAliases).toEqual({ 'local|r1::/tmp/live': [liveKey] })
  })
})

describe('gcStaleWorktreeMeta', () => {
  it('keeps an archived workspace whose checkout was deleted on purpose', () => {
    const worktreeId = 'r1::/definitely/missing/orca/archived'
    const state = makeState({
      repos: [],
      projects: [],
      worktreeMeta: {
        [worktreeId]: {
          ...makeMeta(),
          hostId: 'local',
          comment: 'resume after review',
          isArchived: true,
          archivedCheckout: { branch: 'feature/archived', archivedAt: 1 },
          lastActivityAt: Date.now() - WORKTREE_META_GC_GRACE_MS - 1
        }
      }
    })

    expect(gcStaleWorktreeMeta(state)).toBe(0)
    expect(state.worktreeMeta[worktreeId]?.comment).toBe('resume after review')
  })

  it('reclaims the identity rows of a collected worktree', () => {
    const worktreeId = 'r1::/definitely/missing/orca/path'
    const identityKey = 'wt2:local:dead'
    const remoteIdentityKey = 'wt2:ssh:live'
    const state = makeState({
      repos: [],
      projects: [],
      worktreeMeta: {
        [worktreeId]: {
          hostId: 'local',
          instanceId: 'dead',
          displayName: 'dead',
          lastActivityAt: Date.now() - WORKTREE_META_GC_GRACE_MS - 1
        } as unknown as WorktreeMeta
      },
      worktreeMetaByIdentity: { [identityKey]: makeMeta(), [remoteIdentityKey]: makeMeta() },
      worktreeIdentityAliases: {
        [`local|${worktreeId}`]: [identityKey],
        [`ssh:conn-1|${worktreeId}`]: [remoteIdentityKey]
      }
    })

    expect(gcStaleWorktreeMeta(state)).toBe(1)
    // Dead aliases could attach stale metadata to future worktrees reusing this path.
    expect(state.worktreeMetaByIdentity).toEqual({ [remoteIdentityKey]: expect.anything() })
    expect(state.worktreeIdentityAliases).toEqual({
      [`ssh:conn-1|${worktreeId}`]: [remoteIdentityKey]
    })
  })
})
