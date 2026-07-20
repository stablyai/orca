import type { Mission, MissionMember } from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { areWorktreePathsEqual, worktreePathComparisonKey } from '../ipc/worktree-path-comparison'
import {
  findMissionOwnedWorktreeCandidates,
  type MissionOwnedWorktree
} from './mission-worktree-ownership'
import { assertMissionWorktreeOwnershipMarker } from './mission-worktree-ownership-marker'

function ownershipCandidateKey(candidate: MissionOwnedWorktree): string {
  const parsed = splitWorktreeId(candidate.worktreeId)
  const pathKey = parsed
    ? `${parsed.repoId}\0${worktreePathComparisonKey(parsed.worktreePath)}`
    : candidate.worktreeId
  return `${pathKey}\0${candidate.worktreeInstanceId}`
}

export class MissionMemberOwnershipRecovery {
  constructor(
    private readonly store: Store,
    private readonly runtime: OrcaRuntimeService
  ) {}

  private async inspectOwnedWorktree(
    candidate: MissionOwnedWorktree,
    mission: Pick<Mission, 'id' | 'branchName'>,
    repoId: string
  ): Promise<MissionOwnedWorktree | null> {
    const inspection = await this.runtime.inspectManagedWorktreeForOwnership(candidate.worktreeId)
    if (inspection.status === 'unavailable') {
      throw new Error('mission_member_worktree_liveness_unavailable')
    }
    if (inspection.status === 'missing') {
      return null
    }
    const worktree = inspection.worktree
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const parsedCandidate = splitWorktreeId(candidate.worktreeId)
    if (
      parsedCandidate?.repoId !== repoId ||
      !areWorktreePathsEqual(parsedCandidate.worktreePath, worktree.path) ||
      worktree.repoId !== repoId ||
      worktree.instanceId !== candidate.worktreeInstanceId ||
      branch !== mission.branchName
    ) {
      throw new Error('mission_member_worktree_ownership_unverified')
    }
    const repo = this.store.getRepo(repoId)
    if (!repo) {
      throw new Error('mission_member_worktree_ownership_unverified')
    }
    assertMissionWorktreeOwnershipMarker({
      repoPath: repo.path,
      worktreePath: worktree.path,
      proof: {
        missionId: mission.id,
        repoId,
        worktreeId: candidate.worktreeId,
        worktreeInstanceId: candidate.worktreeInstanceId
      }
    })
    return candidate
  }

  async recoverLiveOwnedWorktree(
    mission: Mission,
    repoId: string
  ): Promise<MissionOwnedWorktree | null> {
    const markerScan = await this.runtime.findManagedWorktreesForMissionOwnership(
      mission.id,
      repoId,
      mission.branchName
    )
    if (markerScan.status === 'unavailable') {
      throw new Error('mission_member_worktree_liveness_unavailable')
    }
    const markerCandidates = markerScan.candidates.map((proof) => ({
      worktreeId: proof.worktreeId,
      worktreeInstanceId: proof.worktreeInstanceId
    }))
    const liveByProof = new Map<string, MissionOwnedWorktree>()
    for (const markerCandidate of markerCandidates) {
      liveByProof.set(ownershipCandidateKey(markerCandidate), markerCandidate)
    }

    for (const candidate of findMissionOwnedWorktreeCandidates(this.store, mission.id, repoId)) {
      const parsedCandidate = splitWorktreeId(candidate.worktreeId)
      const currentMarker = markerCandidates.find((markerCandidate) => {
        const parsedMarker = splitWorktreeId(markerCandidate.worktreeId)
        return (
          parsedCandidate?.repoId === repoId &&
          parsedMarker?.repoId === repoId &&
          areWorktreePathsEqual(parsedCandidate.worktreePath, parsedMarker.worktreePath)
        )
      })
      if (currentMarker) {
        if (currentMarker.worktreeInstanceId !== candidate.worktreeInstanceId) {
          // Why: the current Git row's marker supersedes a debounced stale
          // instance at the same path after external delete/recreate recovery.
          this.store.setWorktreeMeta(candidate.worktreeId, { missionId: undefined })
        }
        continue
      }
      if (await this.inspectOwnedWorktree(candidate, mission, repoId)) {
        liveByProof.set(ownershipCandidateKey(candidate), candidate)
      } else {
        // Why: a missing checkout must not retain ownership that a later
        // same-path non-Mission creation could accidentally inherit.
        this.store.setWorktreeMeta(candidate.worktreeId, { missionId: undefined })
      }
    }
    const live = [...liveByProof.values()]
    if (live.length > 1) {
      throw new Error('mission_member_owned_worktree_ambiguous')
    }
    const recovered = live[0] ?? null
    if (recovered) {
      const member = mission.members.find((entry) => entry.repoId === repoId)
      const parsedMember = member?.worktreeId ? splitWorktreeId(member.worktreeId) : null
      const parsedRecovered = splitWorktreeId(recovered.worktreeId)
      const memberMatchesRecovered =
        parsedMember?.repoId === repoId &&
        parsedRecovered?.repoId === repoId &&
        areWorktreePathsEqual(parsedMember.worktreePath, parsedRecovered.worktreePath) &&
        member?.worktreeInstanceId === recovered.worktreeInstanceId
      if (
        (member?.worktreeId || member?.worktreeInstanceId) &&
        !memberMatchesRecovered &&
        !markerCandidates.some(
          (candidate) => ownershipCandidateKey(candidate) === ownershipCandidateKey(recovered)
        )
      ) {
        throw new Error('mission_member_worktree_ownership_unverified')
      }
      // Why: the Git-admin marker is published before debounced metadata; after
      // a crash it is the durable proof needed to restore the ownership stamp.
      this.store.setWorktreeMeta(recovered.worktreeId, {
        missionId: mission.id,
        instanceId: recovered.worktreeInstanceId
      })
    }
    return recovered
  }

  async recoverMembersBeforeMissionDetach(mission: Mission): Promise<Mission> {
    for (const snapshotMember of mission.members) {
      const currentMission = this.store.getMission(mission.id)
      const currentMember = currentMission?.members.find(
        (member) => member.repoId === snapshotMember.repoId
      )
      if (!currentMission || !currentMember) {
        throw new Error('mission_member_not_found')
      }
      const recovered = await this.recoverLiveOwnedWorktree(currentMission, currentMember.repoId)
      if (
        recovered &&
        (currentMember.worktreeId !== recovered.worktreeId ||
          currentMember.worktreeInstanceId !== recovered.worktreeInstanceId)
      ) {
        this.store.setMissionMemberWorktree(
          currentMission.id,
          currentMember.repoId,
          recovered.worktreeId,
          recovered.worktreeInstanceId
        )
      }
    }
    // Why: deleting while preserving checkouts may remove the root view next;
    // persist recovered pointers before that irreversible ordering boundary.
    this.store.flushOrThrow()
    const recoveredMission = this.store.getMission(mission.id)
    if (!recoveredMission) {
      throw new Error('mission_not_found')
    }
    return recoveredMission
  }

  async clearStrictlyMissingMemberPointer(mission: Mission, member: MissionMember): Promise<void> {
    if (!member.worktreeId) {
      throw new Error('mission_member_worktree_ownership_unverified')
    }
    const inspection = await this.runtime.inspectManagedWorktreeForOwnership(member.worktreeId)
    if (inspection.status === 'unavailable') {
      throw new Error('mission_member_worktree_liveness_unavailable')
    }
    if (inspection.status === 'found') {
      throw new Error('mission_member_worktree_ownership_unverified')
    }
    // Why: generic/external deletion can remove checkout metadata before the
    // Mission pointer; only a strict missing result permits clearing it.
    this.store.setMissionMemberWorktree(mission.id, member.repoId, null, null)
  }
}
