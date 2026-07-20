import type { Mission, WorktreeMeta } from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import { readMissionWorktreeCreateIntent } from './mission-worktree-create-intent'
import { readMissionWorktreeOwnershipMarker } from './mission-worktree-ownership-marker'

export const MISSION_MANAGED_MEMBER_REMOVAL_ERROR = 'mission_member_managed_by_mission'

type MissionRemovalBoundaryReader = {
  getMissions?: () => Mission[]
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
}

export function assertWorktreeIsNotMissionManaged(
  store: MissionRemovalBoundaryReader,
  worktreeId: string,
  localGitTarget?: { repoPath: string; worktreePath: string }
): void {
  const metadataOwner = store.getWorktreeMeta(worktreeId)?.missionId
  const missions = store.getMissions?.()
  const memberOwner = missions?.find((mission) =>
    mission.members.some((member) => member.worktreeId === worktreeId)
  )?.id
  const parsedWorktreeId = splitWorktreeId(worktreeId)
  const intentOwner =
    localGitTarget && parsedWorktreeId
      ? missions?.find((mission) => {
          if (
            !mission.rootPath ||
            !mission.rootBasePath ||
            !mission.members.some((member) => member.repoId === parsedWorktreeId.repoId)
          ) {
            return false
          }
          const intent = readMissionWorktreeCreateIntent(
            {
              baseDir: mission.rootBasePath,
              rootPath: mission.rootPath,
              missionId: mission.id
            },
            parsedWorktreeId.repoId
          )
          return (
            intent !== null &&
            areWorktreePathsEqual(intent.worktreePath, localGitTarget.worktreePath)
          )
        })?.id
      : undefined
  // Why: after Mission deletion, a crash may leave only stale metadata; an
  // authoritative Mission list lets generic cleanup recover that orphan.
  const liveMetadataOwner =
    metadataOwner !== undefined &&
    (missions === undefined || missions.some((mission) => mission.id === metadataOwner))
  const marker = localGitTarget ? readMissionWorktreeOwnershipMarker(localGitTarget) : null
  if (marker) {
    const parsedMarkerId = splitWorktreeId(marker.worktreeId)
    if (
      !localGitTarget ||
      parsedMarkerId?.repoId !== marker.repoId ||
      !areWorktreePathsEqual(parsedMarkerId.worktreePath, localGitTarget.worktreePath)
    ) {
      throw new Error('mission_member_worktree_ownership_unverified')
    }
  }
  const liveMarkerOwner =
    marker !== null &&
    (missions === undefined ||
      missions.some(
        (mission) =>
          mission.id === marker.missionId &&
          mission.members.some((member) => member.repoId === marker.repoId)
      ))
  if (liveMetadataOwner || memberOwner || intentOwner || liveMarkerOwner) {
    // Why: only Mission lifecycle deletion verifies the durable ownership stamp
    // and updates the member record atomically with checkout removal.
    throw new Error(MISSION_MANAGED_MEMBER_REMOVAL_ERROR)
  }
}

export function assertRepoIsNotMissionManaged(missions: Mission[], repoId: string): void {
  if (missions.some((mission) => mission.members.some((member) => member.repoId === repoId))) {
    // Why: generic project removal prunes worktree metadata without updating
    // Mission membership, leaving an in-root checkout with no ownership proof.
    throw new Error(MISSION_MANAGED_MEMBER_REMOVAL_ERROR)
  }
}
