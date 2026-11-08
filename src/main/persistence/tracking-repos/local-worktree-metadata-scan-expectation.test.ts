import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo
} from './missing-local-worktree-metadata-pruning'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace/stale`
const LOCAL_ALIAS = `local|${WORKTREE_ID}`
const IDENTITY_KEY = 'local-identity'

function makeRepo(id = REPO_ID): Repo {
  return {
    id,
    path: `/workspace/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0
  }
}

function makeMeta(worktreeId = WORKTREE_ID): WorktreeMeta {
  return {
    instanceId: `instance-${worktreeId}`,
    hostId: 'local',
    displayName: worktreeId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [makeRepo()]
  return state
}

function makeCanonicalOnlyState(): {
  state: PersistedState
  meta: WorktreeMeta
} {
  const state = makeState()
  const meta = makeMeta()
  state.worktreeMetaByIdentity = { [IDENTITY_KEY]: meta }
  state.worktreeIdentityAliases = { [LOCAL_ALIAS]: [IDENTITY_KEY] }
  return { state, meta }
}

function pruneCaptured(state: PersistedState): string[] {
  const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
  return pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)
}

describe('local worktree metadata scan expectations', () => {
  it('captures canonical-only local metadata and removes its orphaned identity row', () => {
    const { state } = makeCanonicalOnlyState()

    expect(pruneCaptured(state)).toEqual([WORKTREE_ID])
    expect(state.worktreeMeta[WORKTREE_ID]).toBeUndefined()
    expect(state.worktreeIdentityAliases?.[LOCAL_ALIAS]).toBeUndefined()
    expect(state.worktreeMetaByIdentity?.[IDENTITY_KEY]).toBeUndefined()
  })

  it('does not sweep an unrelated unaliased canonical row during pruning', () => {
    const { state, meta } = makeCanonicalOnlyState()
    const unrelated = makeMeta(`${REPO_ID}::/workspace/unrelated`)
    state.worktreeMetaByIdentity!.unrelated = unrelated

    expect(pruneCaptured(state)).toEqual([WORKTREE_ID])
    expect(state.worktreeMetaByIdentity).toEqual({ unrelated })
    expect(state.worktreeMetaByIdentity?.[IDENTITY_KEY]).not.toBeDefined()
    expect(meta).not.toBe(unrelated)
  })

  it('preserves metadata when an alias array is replaced with identical contents', () => {
    const { state } = makeCanonicalOnlyState()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    state.worktreeIdentityAliases![LOCAL_ALIAS] = [IDENTITY_KEY]

    expect(pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)).toEqual(
      []
    )
    expect(state.worktreeMetaByIdentity?.[IDENTITY_KEY]).toBeDefined()
  })

  it.each([
    [
      'added',
      (state: PersistedState) => {
        state.worktreeIdentityAliases![`ssh:builder|${WORKTREE_ID}`] = [IDENTITY_KEY]
      }
    ],
    [
      'removed',
      (state: PersistedState) => {
        delete state.worktreeIdentityAliases![LOCAL_ALIAS]
      }
    ]
  ] as const)('preserves metadata when an alias is %s during the scan', (_label, mutate) => {
    const { state } = makeCanonicalOnlyState()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    mutate(state)

    expect(pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)).toEqual(
      []
    )
    expect(state.worktreeMetaByIdentity?.[IDENTITY_KEY]).toBeDefined()
  })

  it('preserves a legacy row created after a canonical-only scan capture', () => {
    const { state } = makeCanonicalOnlyState()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    state.worktreeMeta[WORKTREE_ID] = makeMeta()

    expect(pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)).toEqual(
      []
    )
    expect(state.worktreeMeta[WORKTREE_ID]).toBeDefined()
  })
})
