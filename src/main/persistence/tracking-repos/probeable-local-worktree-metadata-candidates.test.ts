import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo,
  selectProbeableLocalWorktreeMetadataCandidates
} from './missing-local-worktree-metadata-pruning'

const REPO_ID = 'repo-1'

function makeRepo(): Repo {
  return {
    id: REPO_ID,
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
}

function makeMeta(worktreeId: string, overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
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
    lastActivityAt: 0,
    ...overrides
  }
}

function makeState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [makeRepo()]
  return state
}

function probeableIds(state: PersistedState): string[] {
  const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
  return selectProbeableLocalWorktreeMetadataCandidates(state, scan, 'linux').map(
    ({ worktreeId }) => worktreeId
  )
}

describe('selectProbeableLocalWorktreeMetadataCandidates', () => {
  it('keeps an ordinary sessionless local row', () => {
    const state = makeState()
    const id = `${REPO_ID}::/workspace/gone`
    state.worktreeMeta[id] = makeMeta(id)

    expect(probeableIds(state)).toEqual([id])
  })

  it('drops a row a persisted session still pins', () => {
    const state = makeState()
    const pinned = `${REPO_ID}::/workspace/pinned`
    const free = `${REPO_ID}::/workspace/free`
    state.worktreeMeta[pinned] = makeMeta(pinned)
    state.worktreeMeta[free] = makeMeta(free)
    state.ui.lastActiveWorktreeId = pinned

    expect(probeableIds(state)).toEqual([free])
  })

  it('drops a row whose locator is also known on a remote host', () => {
    const state = makeState()
    const shared = `${REPO_ID}::/workspace/shared`
    const free = `${REPO_ID}::/workspace/free`
    state.worktreeMeta[shared] = makeMeta(shared)
    state.worktreeMeta[free] = makeMeta(free)
    state.worktreeIdentityAliases = { [`ssh:box|${shared}`]: ['identity-1'] }

    expect(probeableIds(state)).toEqual([free])
  })

  it('drops a row pinned to another execution host', () => {
    const state = makeState()
    const remote = `${REPO_ID}::/workspace/remote`
    state.worktreeMeta[remote] = makeMeta(remote, { hostId: 'ssh:box' })

    expect(probeableIds(state)).toEqual([])
  })

  it('never widens what the authoritative prune would remove', () => {
    const state = makeState()
    const ids = [
      `${REPO_ID}::/workspace/free`,
      `${REPO_ID}::/workspace/pinned`,
      `${REPO_ID}::/workspace/remote`
    ]
    state.worktreeMeta[ids[0]] = makeMeta(ids[0])
    state.worktreeMeta[ids[1]] = makeMeta(ids[1])
    state.worktreeMeta[ids[2]] = makeMeta(ids[2], { hostId: 'ssh:box' })
    state.ui.lastActiveWorktreeId = ids[1]

    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)
    const selected = selectProbeableLocalWorktreeMetadataCandidates(state, scan, 'linux')
    // Feeding the unfiltered capture to the authoritative prune must reach the same verdict.
    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepo(
      state,
      scan,
      scan.metadata,
      'linux'
    )

    expect(selected.map(({ worktreeId }) => worktreeId)).toEqual(removed)
  })
})
