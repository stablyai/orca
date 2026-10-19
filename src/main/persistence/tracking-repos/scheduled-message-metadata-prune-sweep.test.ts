import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ScheduledMessage } from '../../../shared/scheduled-message-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo
} from './missing-local-worktree-metadata-pruning'
import { pruneWorktreeStateForRepo } from './repo-worktree-pruning'
import { gcStaleWorktreeMeta, WORKTREE_META_GC_GRACE_MS } from './worktree-metadata-normalization'

// `when-idle` is the timing nothing else reclaims: no due time, so no attempt ever fails it.
function makeMessage(worktreeId: string, id = `msg-${worktreeId}`): ScheduledMessage {
  return {
    id,
    worktreeId,
    text: 'ping',
    timing: { kind: 'when-idle' },
    createdAt: 0,
    status: 'pending'
  }
}

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    instanceId: 'instance',
    hostId: 'local',
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    lastActivityAt: 0,
    ...overrides
  }
}

function worktreeIdsWithScheduledMessages(state: PersistedState): string[] {
  return (state.scheduledMessages ?? []).map((message) => message.worktreeId)
}

describe('scheduled-message sweep on metadata-prune paths', () => {
  it("drops the removed repo's rows from pruneWorktreeStateForRepo", () => {
    const state = getDefaultPersistedState('/home/test')
    state.worktreeMeta = {
      'gone::/wt/a': makeMeta(),
      'gone::/wt/b': makeMeta(),
      'kept::/wt/c': makeMeta()
    }
    state.scheduledMessages = [
      makeMessage('gone::/wt/a'),
      makeMessage('gone::/wt/b'),
      makeMessage('kept::/wt/c')
    ]

    pruneWorktreeStateForRepo(state, 'gone', null, () => {})

    expect(worktreeIdsWithScheduledMessages(state)).toEqual(['kept::/wt/c'])
  })

  it('keeps the surviving host rows when the prune is host-scoped', () => {
    const state = getDefaultPersistedState('/home/test')
    state.worktreeMeta = {
      'shared::/wt/local': makeMeta({ hostId: 'local' }),
      'shared::/wt/remote': makeMeta({ hostId: 'ssh:box' })
    }
    state.scheduledMessages = [makeMessage('shared::/wt/local'), makeMessage('shared::/wt/remote')]

    pruneWorktreeStateForRepo(state, 'shared', 'ssh:box', () => {})

    expect(worktreeIdsWithScheduledMessages(state)).toEqual(['shared::/wt/local'])
  })

  it('drops the rows of a worktree gcStaleWorktreeMeta reclaims', () => {
    const state = getDefaultPersistedState('/home/test')
    const staleId = 'repo-1::/workspace/deleted-outside-orca'
    state.repos = [
      { id: 'repo-1', path: '/workspace/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
    ]
    state.worktreeMeta = {
      [staleId]: makeMeta({
        hostId: 'local',
        createdAt: Date.now() - WORKTREE_META_GC_GRACE_MS - 1,
        lastActivityAt: Date.now() - WORKTREE_META_GC_GRACE_MS - 1
      })
    }
    state.scheduledMessages = [makeMessage(staleId)]

    expect(gcStaleWorktreeMeta(state)).toBe(1)

    expect(state.scheduledMessages).toEqual([])
  })

  it('drops the rows of a worktree the sessionless metadata prune removes', () => {
    const state = getDefaultPersistedState('/home/test')
    const staleId = 'repo-1::/workspace/stale'
    const liveId = 'repo-1::/workspace/live'
    state.repos = [
      { id: 'repo-1', path: '/workspace/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
    ]
    state.worktreeMeta = { [staleId]: makeMeta({ hostId: 'local' }), [liveId]: makeMeta() }
    state.scheduledMessages = [makeMessage(staleId), makeMessage(liveId)]
    const scan = captureNativeLocalWorktreeMetadataScanExpectation(state, state.repos[0]!)

    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepo(
      state,
      scan,
      scan.metadata.filter(({ worktreeId }) => worktreeId === staleId)
    )

    expect(removed).toEqual([staleId])
    expect(worktreeIdsWithScheduledMessages(state)).toEqual([liveId])
  })
})
