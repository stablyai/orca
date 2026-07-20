import path from 'node:path'
import { getMissionRootDirName, getMissionWorktreeName } from '../../shared/missions'
import type { Mission, MissionMember, MissionMemberResult } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import { MissionMemberOwnershipRecovery } from './mission-member-ownership-recovery'
import { requireNativeLocalMissionRepos } from './mission-repo-eligibility'
import {
  findMissionOwnedWorktreeCandidates,
  getMissionOwnedWorktree,
  type MissionOwnedWorktree
} from './mission-worktree-ownership'
import {
  removeMissionWorktreeOwnershipMarker,
  type MissionWorktreeOwnershipProof
} from './mission-worktree-ownership-marker'

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MissionMemberLifecycle {
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly ownershipRecovery: MissionMemberOwnershipRecovery

  constructor(
    private readonly store: Store,
    private readonly runtime: OrcaRuntimeService
  ) {
    this.ownershipRecovery = new MissionMemberOwnershipRecovery(store, runtime)
  }

  run<T>(missionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(missionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.operationTails.set(missionId, tail)
    void tail.finally(() => {
      if (this.operationTails.get(missionId) === tail) {
        this.operationTails.delete(missionId)
      }
    })
    return current
  }

  async createWorktree(mission: Mission, repoId: string): Promise<MissionMemberResult> {
    try {
      requireNativeLocalMissionRepos(this.store, [repoId])
      const currentMission = this.store.getMission(mission.id)
      const member = currentMission?.members.find((entry) => entry.repoId === repoId)
      if (!currentMission || !member) {
        throw new Error('mission_member_not_found')
      }

      // Why: metadata ownership is durable before the member pointer. Adopt
      // that crash-window worktree instead of creating a second checkout.
      const recovered = await this.ownershipRecovery.recoverLiveOwnedWorktree(
        currentMission,
        repoId
      )
      if (recovered) {
        this.store.setMissionMemberWorktree(
          currentMission.id,
          repoId,
          recovered.worktreeId,
          recovered.worktreeInstanceId
        )
        return {
          repoId,
          worktreeId: recovered.worktreeId,
          worktreeInstanceId: recovered.worktreeInstanceId
        }
      }
      const recorded = getMissionOwnedWorktree(this.store, currentMission, member)
      if ((member.worktreeId || member.worktreeInstanceId) && !recorded) {
        await this.ownershipRecovery.clearStrictlyMissingMemberPointer(currentMission, member)
      }

      const pathSeed = [
        getMissionWorktreeName(currentMission.branchName),
        currentMission.id.slice(0, 8),
        repoId.slice(0, 8)
      ].join('-')
      const repo = this.store.getRepo(repoId)
      if (!repo || !currentMission.rootPath) {
        throw new Error('mission_root_not_ready')
      }
      const memberDirectoryName = `${getMissionRootDirName(repo.displayName)}-${repoId.slice(0, 8)}`
      const created = await this.runtime.createManagedWorktree({
        repoSelector: `id:${repoId}`,
        // Why: flat workspace layouts share one directory; the path seed must
        // be unique without changing the branch shared across repositories.
        name: pathSeed,
        displayName: this.store.getRepo(repoId)?.displayName ?? currentMission.name,
        branchNameOverride: currentMission.branchName,
        requireExactBranchName: true,
        missionId: currentMission.id,
        // Why: agents launched at the Mission root need canonical in-tree
        // directories for discovery and sandbox writes; sibling symlinks are insufficient.
        worktreePathOverride: path.join(currentMission.rootPath, memberDirectoryName),
        activate: false,
        skipInitialTerminal: true,
        runHooks: false,
        setupDecision: 'skip'
      })
      const parsed = splitWorktreeId(created.worktree.id)
      const meta = this.store.getWorktreeMeta(created.worktree.id)
      const actualBranch = created.worktree.branch.replace(/^refs\/heads\//, '')
      if (
        parsed?.repoId !== repoId ||
        actualBranch !== currentMission.branchName ||
        meta?.missionId !== currentMission.id ||
        !meta.instanceId
      ) {
        throw new Error('mission_member_worktree_ownership_stamp_failed')
      }
      this.store.setMissionMemberWorktree(
        currentMission.id,
        repoId,
        created.worktree.id,
        meta.instanceId
      )
      return {
        repoId,
        worktreeId: created.worktree.id,
        worktreeInstanceId: meta.instanceId
      }
    } catch (error) {
      const message = toErrorMessage(error)
      this.store.setMissionMemberError(mission.id, repoId, message)
      return { repoId, worktreeId: null, error: message }
    }
  }

  // Why: parallel create calls can contend on Git locks; deterministic member
  // ordering also makes partial results and retry behavior stable.
  async createWorktrees(mission: Mission, repoIds: string[]): Promise<MissionMemberResult[]> {
    const results: MissionMemberResult[] = []
    for (const repoId of repoIds) {
      results.push(await this.createWorktree(mission, repoId))
    }
    return results
  }

  async removeWorktree(mission: Mission, member: MissionMember): Promise<MissionMemberResult> {
    try {
      requireNativeLocalMissionRepos(this.store, [member.repoId])
      // Why: a crash can stamp ownership before the member pointer is saved.
      // Resolve the durable candidate before removing the member record.
      const owned = await this.ownershipRecovery.recoverLiveOwnedWorktree(mission, member.repoId)
      if (!owned) {
        const recorded = getMissionOwnedWorktree(this.store, mission, member)
        if ((member.worktreeId || member.worktreeInstanceId) && !recorded) {
          await this.ownershipRecovery.clearStrictlyMissingMemberPointer(mission, member)
        }
        this.store.removeMissionMember(mission.id, member.repoId)
        return { repoId: member.repoId, worktreeId: null }
      }
      if (
        member.worktreeId !== owned.worktreeId ||
        member.worktreeInstanceId !== owned.worktreeInstanceId
      ) {
        this.store.setMissionMemberWorktree(
          mission.id,
          member.repoId,
          owned.worktreeId,
          owned.worktreeInstanceId
        )
      }
      // Why: Mission creation has no hook-trust confirmation, so deletion may
      // not execute archive hooks merely because the worktree is Mission-owned.
      const removed = await this.runtime.removeManagedWorktree(
        `id:${owned.worktreeId}`,
        false,
        false,
        {
          missionId: mission.id,
          repoId: member.repoId,
          worktreeId: owned.worktreeId,
          worktreeInstanceId: owned.worktreeInstanceId
        }
      )
      this.store.removeMissionMember(mission.id, member.repoId)
      const warnings = [
        removed.warning,
        removed.preservedBranch
          ? `Preserved local branch ${removed.preservedBranch.branchName}.`
          : undefined
      ].filter((warning): warning is string => Boolean(warning))
      return {
        repoId: member.repoId,
        worktreeId: null,
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
      }
    } catch (error) {
      const message = toErrorMessage(error)
      this.store.setMissionMemberError(mission.id, member.repoId, message)
      return { repoId: member.repoId, worktreeId: member.worktreeId, error: message }
    }
  }

  async detachMember(mission: Mission, member: MissionMember): Promise<MissionMemberResult> {
    try {
      requireNativeLocalMissionRepos(this.store, [member.repoId])
      const owned = await this.ownershipRecovery.recoverLiveOwnedWorktree(mission, member.repoId)
      if (!owned) {
        const recorded = getMissionOwnedWorktree(this.store, mission, member)
        if ((member.worktreeId || member.worktreeInstanceId) && !recorded) {
          await this.ownershipRecovery.clearStrictlyMissingMemberPointer(mission, member)
        }
      }
      if (owned) {
        const parsed = splitWorktreeId(owned.worktreeId)
        if (
          parsed &&
          mission.rootPath &&
          areWorktreePathsEqual(path.dirname(parsed.worktreePath), mission.rootPath)
        ) {
          // Why: leaving a physical child behind would keep the removed repo
          // visible and writable from the still-active Mission session.
          throw new Error('mission_member_workspace_delete_required')
        }
      }
      this.detachOwnership(mission, member)
      this.store.removeMissionMember(mission.id, member.repoId)
      return { repoId: member.repoId, worktreeId: null }
    } catch (error) {
      const message = toErrorMessage(error)
      this.store.setMissionMemberError(mission.id, member.repoId, message)
      return { repoId: member.repoId, worktreeId: member.worktreeId, error: message }
    }
  }

  recoverMembersBeforeMissionDetach(mission: Mission): Promise<Mission> {
    return this.ownershipRecovery.recoverMembersBeforeMissionDetach(mission)
  }

  detachDeletedMissionOwnership(mission: Mission): void {
    for (const member of mission.members) {
      this.detachOwnership(mission, member)
    }
  }

  detachOwnership(mission: Mission, member: MissionMember): void {
    const owned = getMissionOwnedWorktree(this.store, mission, member)
    const candidates = new Map<string, MissionOwnedWorktree>()
    if (owned) {
      candidates.set(owned.worktreeId, owned)
    }
    for (const candidate of findMissionOwnedWorktreeCandidates(
      this.store,
      mission.id,
      member.repoId
    )) {
      candidates.set(candidate.worktreeId, candidate)
    }
    for (const candidate of candidates.values()) {
      const repo = this.store.getRepo(member.repoId)
      const parsed = splitWorktreeId(candidate.worktreeId)
      if (repo && parsed) {
        const proof: MissionWorktreeOwnershipProof = {
          missionId: mission.id,
          repoId: member.repoId,
          worktreeId: candidate.worktreeId,
          worktreeInstanceId: candidate.worktreeInstanceId
        }
        try {
          removeMissionWorktreeOwnershipMarker({
            repoPath: repo.path,
            worktreePath: parsed.worktreePath,
            proof
          })
        } catch {
          // The checkout is intentionally preserved; stale or missing markers
          // must not prevent clearing Orca's non-destructive Mission metadata.
        }
      }
      this.store.setWorktreeMeta(candidate.worktreeId, { missionId: undefined })
    }
  }

  async teardownSession(mission: Mission): Promise<void> {
    const workspace = this.store.getMissionSessionWorkspace(mission.id)
    if (workspace) {
      await this.runtime.teardownWorkspaceProcesses(folderWorkspaceKey(workspace.id))
    }
  }
}
