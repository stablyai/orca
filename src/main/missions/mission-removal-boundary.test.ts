import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../shared/types'

const readOwnershipMarker = vi.hoisted(() => vi.fn())
const readCreateIntent = vi.hoisted(() => vi.fn())

vi.mock('./mission-worktree-ownership-marker', () => ({
  readMissionWorktreeOwnershipMarker: readOwnershipMarker
}))
vi.mock('./mission-worktree-create-intent', () => ({
  readMissionWorktreeCreateIntent: readCreateIntent
}))

import { assertWorktreeIsNotMissionManaged } from './mission-removal-boundary'

const worktreeId = 'repo-1::/workspaces/member'
const target = { repoPath: '/repos/repo-1', worktreePath: '/workspaces/member' }

function mission(): Mission {
  return {
    id: 'mission-1',
    name: 'Cross repo task',
    branchName: 'mission/cross-repo-task',
    members: [{ repoId: 'repo-1', worktreeId: null, addedAt: 1 }],
    tabOrder: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Mission worktree removal boundary', () => {
  beforeEach(() => {
    readOwnershipMarker.mockReset().mockReturnValue(null)
    readCreateIntent.mockReset().mockReturnValue(null)
  })

  it('blocks generic removal during the add-complete intent-only crash window', () => {
    readCreateIntent.mockReturnValue({
      version: 1,
      missionId: 'mission-1',
      repoId: 'repo-1',
      branchName: 'mission/cross-repo-task',
      worktreePath: target.worktreePath,
      worktreeInstanceId: 'instance-1',
      preserveBranchOnDelete: false
    })
    const liveMission = {
      ...mission(),
      rootBasePath: '/workspaces/missions',
      rootPath: '/workspaces/missions/cross-repo-task'
    }
    const store = {
      getMissions: () => [liveMission],
      getWorktreeMeta: () => undefined
    }

    expect(() => assertWorktreeIsNotMissionManaged(store, worktreeId, target)).toThrow(
      'mission_member_managed_by_mission'
    )
    expect(readCreateIntent).toHaveBeenCalledWith(
      {
        baseDir: liveMission.rootBasePath,
        rootPath: liveMission.rootPath,
        missionId: liveMission.id
      },
      'repo-1'
    )
  })

  it('blocks generic removal during the marker-only crash window', () => {
    readOwnershipMarker.mockReturnValue({
      missionId: 'mission-1',
      repoId: 'repo-1',
      worktreeId,
      worktreeInstanceId: 'instance-1'
    })
    const store = {
      getMissions: () => [mission()],
      getWorktreeMeta: () => undefined
    }

    expect(() => assertWorktreeIsNotMissionManaged(store, worktreeId, target)).toThrow(
      'mission_member_managed_by_mission'
    )
  })

  it('allows cleanup of a marker orphan after its Mission is durably gone', () => {
    readOwnershipMarker.mockReturnValue({
      missionId: 'mission-1',
      repoId: 'repo-1',
      worktreeId,
      worktreeInstanceId: 'instance-1'
    })
    const store = { getMissions: () => [], getWorktreeMeta: () => undefined }

    expect(() => assertWorktreeIsNotMissionManaged(store, worktreeId, target)).not.toThrow()
  })

  it('fails closed when a marker names a different worktree path', () => {
    readOwnershipMarker.mockReturnValue({
      missionId: 'mission-1',
      repoId: 'repo-1',
      worktreeId: 'repo-1::/workspaces/replacement',
      worktreeInstanceId: 'instance-1'
    })
    const store = { getMissions: () => [], getWorktreeMeta: () => undefined }

    expect(() => assertWorktreeIsNotMissionManaged(store, worktreeId, target)).toThrow(
      'mission_member_worktree_ownership_unverified'
    )
  })
})
