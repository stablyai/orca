import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type * as WriteSchedulingModule from './write-scheduling'
import { MetadataLineageOperations } from './metadata-lineage-operations'

const { scheduleSaveMock } = vi.hoisted(() => ({ scheduleSaveMock: vi.fn() }))

vi.mock('./write-scheduling', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteSchedulingModule>()),
  scheduleSave: scheduleSaveMock
}))

const REPO: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

function makeMeta(worktreeId: string): WorktreeMeta {
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

describe('MetadataLineageOperations batch metadata pruning', () => {
  it('schedules one save for thousands of removals and none for a no-op retry', () => {
    const state = getDefaultPersistedState('/home/test')
    state.repos = [REPO]
    const staleIds = Array.from(
      { length: 2_709 },
      (_, index) => `${REPO.id}::/workspace/stale-${index}`
    )
    for (const worktreeId of staleIds) {
      state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    }
    const operations = new MetadataLineageOperations({ state } as never, {} as never, {} as never)
    const scan = operations.captureNativeLocalWorktreeMetadataScanExpectation(REPO)

    expect(
      operations.pruneSessionlessMissingLocalWorktreeMetadataForRepo(scan, scan.metadata)
    ).toHaveLength(staleIds.length)
    expect(scheduleSaveMock).toHaveBeenCalledTimes(1)

    expect(
      operations.pruneSessionlessMissingLocalWorktreeMetadataForRepo(scan, scan.metadata)
    ).toEqual([])
    expect(scheduleSaveMock).toHaveBeenCalledTimes(1)
  })
})
