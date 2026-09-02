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

  it('removes equal legacy and canonical projections after a persistence round trip', () => {
    const state = makeState()
    const meta = makeMeta()
    state.worktreeMeta[WORKTREE_ID] = structuredClone(meta)
    state.worktreeMetaByIdentity = { [IDENTITY_KEY]: structuredClone(meta) }
    state.worktreeIdentityAliases = { [LOCAL_ALIAS]: [IDENTITY_KEY] }

    expect(pruneCaptured(state)).toEqual([WORKTREE_ID])
    expect(state.worktreeMeta[WORKTREE_ID]).toBeUndefined()
    expect(state.worktreeIdentityAliases[LOCAL_ALIAS]).toBeUndefined()
    expect(state.worktreeMetaByIdentity[IDENTITY_KEY]).toBeUndefined()
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

  it('allocates expectations only for the scanned repository', () => {
    const state = makeState()
    const otherRepo = makeRepo('repo-2')
    const otherId = `${otherRepo.id}::/workspace/other`
    const canonicalId = `${REPO_ID}::/workspace/canonical`
    const canonicalKey = 'canonical-key'
    state.repos.push(otherRepo)
    state.worktreeMeta[WORKTREE_ID] = makeMeta()
    state.worktreeMeta[otherId] = makeMeta(otherId)
    state.worktreeMetaByIdentity = {
      [canonicalKey]: makeMeta(canonicalId),
      'other-key': makeMeta(otherId)
    }
    state.worktreeIdentityAliases = {
      [`local|${canonicalId}`]: [canonicalKey],
      [`local|${otherId}`]: ['other-key']
    }

    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)

    expect(scan.metadata.map(({ worktreeId }) => worktreeId).sort()).toEqual(
      [WORKTREE_ID, canonicalId].sort()
    )
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

  it('preserves metadata when the captured alias array is mutated in place', () => {
    const { state } = makeCanonicalOnlyState()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    state.worktreeIdentityAliases![LOCAL_ALIAS]!.push('new-identity')
    state.worktreeMetaByIdentity!['new-identity'] = makeMeta()

    expect(pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)).toEqual(
      []
    )
  })

  it.each([
    [
      'replaced',
      (state: PersistedState) => {
        state.worktreeMetaByIdentity![IDENTITY_KEY] = {
          ...state.worktreeMetaByIdentity![IDENTITY_KEY]!
        }
      }
    ],
    [
      'host-mutated',
      (state: PersistedState) => {
        state.worktreeMetaByIdentity![IDENTITY_KEY]!.hostId = 'ssh:builder'
      }
    ],
    [
      'instance-mutated',
      (state: PersistedState) => {
        state.worktreeMetaByIdentity![IDENTITY_KEY]!.instanceId = 'new-instance'
      }
    ],
    [
      'content-mutated',
      (state: PersistedState) => {
        state.worktreeMetaByIdentity![IDENTITY_KEY]!.comment = 'new comment'
      }
    ]
  ] as const)('preserves metadata when a canonical row is %s', (_label, mutate) => {
    const { state } = makeCanonicalOnlyState()
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    mutate(state)

    expect(pruneSessionlessMissingLocalWorktreeMetadataForRepo(state, scan, scan.metadata)).toEqual(
      []
    )
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

  it.each([WORKTREE_ID, `bogus|${WORKTREE_ID}`, `ssh:builder|${WORKTREE_ID}`])(
    'preserves metadata with an unqualified or foreign alias: %s',
    (alias) => {
      const state = makeState()
      state.worktreeMeta[WORKTREE_ID] = makeMeta()
      state.worktreeMetaByIdentity = { [IDENTITY_KEY]: state.worktreeMeta[WORKTREE_ID]! }
      state.worktreeIdentityAliases = { [alias]: [IDENTITY_KEY] }

      expect(pruneCaptured(state)).toEqual([])
      expect(state.worktreeMeta[WORKTREE_ID]).toBeDefined()
    }
  )

  it('preserves an unqualified alias whose worktree path contains a pipe', () => {
    const state = makeState()
    const pipedId = `${REPO_ID}::/workspace/a|b`
    state.worktreeMeta[pipedId] = makeMeta(pipedId)
    state.worktreeMetaByIdentity = { [IDENTITY_KEY]: state.worktreeMeta[pipedId]! }
    state.worktreeIdentityAliases = { [pipedId]: [IDENTITY_KEY] }

    expect(pruneCaptured(state)).toEqual([])
    expect(state.worktreeMeta[pipedId]).toBeDefined()
    expect(state.worktreeIdentityAliases[pipedId]).toEqual([IDENTITY_KEY])
  })
})
