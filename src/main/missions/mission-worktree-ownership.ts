import type { Mission, MissionMember } from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'

export type MissionOwnedWorktree = {
  worktreeId: string
  worktreeInstanceId: string
}

/** Persistence is untrusted input here: all three ownership stamps must agree
 * before a Mission may project, detach, or remove a worktree. */
export function getMissionOwnedWorktree(
  store: Store,
  mission: Pick<Mission, 'id'>,
  member: Pick<MissionMember, 'repoId' | 'worktreeId' | 'worktreeInstanceId'>
): MissionOwnedWorktree | null {
  if (!member.worktreeId || !member.worktreeInstanceId) {
    return null
  }
  const parsed = splitWorktreeId(member.worktreeId)
  const meta = store.getWorktreeMeta(member.worktreeId)
  if (
    parsed?.repoId !== member.repoId ||
    meta?.missionId !== mission.id ||
    meta.instanceId !== member.worktreeInstanceId
  ) {
    return null
  }
  return {
    worktreeId: member.worktreeId,
    worktreeInstanceId: member.worktreeInstanceId
  }
}

/** Finds durable Mission-owned worktrees after a crash between runtime create
 * and member-pointer persistence. The caller must still verify liveness. */
export function findMissionOwnedWorktreeCandidates(
  store: Store,
  missionId: string,
  repoId: string
): MissionOwnedWorktree[] {
  const candidates: MissionOwnedWorktree[] = []
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId !== repoId || meta.missionId !== missionId || !meta.instanceId) {
      continue
    }
    candidates.push({ worktreeId, worktreeInstanceId: meta.instanceId })
  }
  return candidates
}
