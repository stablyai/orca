import os from 'node:os'
import type { Mission } from '../../shared/types'
import { getMissionRootDirName } from '../../shared/missions'
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'
import {
  ensureMissionRoot,
  removeMissionRoot,
  resolveMissionRootPath,
  resolveMissionsBaseDir,
  type MissionRootLink
} from './mission-root'

export function getLocalMissionMemberLinks(store: Store, mission: Mission): MissionRootLink[] {
  const links: MissionRootLink[] = []
  const usedNames = new Set<string>()
  for (const member of mission.members) {
    if (!member.worktreeId) {
      continue
    }
    const repo = store.getRepo(member.repoId)
    // Why: the mission root is a local directory; only local worktrees can be
    // linked into it. SSH/runtime members stay reachable via their cards.
    if (!repo || repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
      continue
    }
    const parsed = splitWorktreeId(member.worktreeId)
    if (!parsed) {
      continue
    }
    // Why: sanitized display names can collide ("Dashboard" vs "Dashboard!");
    // every local member must keep its own link, so suffix in member order.
    let name = getMissionRootDirName(repo.displayName)
    if (usedNames.has(name)) {
      let suffix = 2
      while (usedNames.has(`${name}-${suffix}`)) {
        suffix += 1
      }
      name = `${name}-${suffix}`
    }
    usedNames.add(name)
    links.push({ name, targetPath: parsed.worktreePath })
  }
  return links
}

/** Strict ensure used by session open: resolves and persists the root path on
 *  first use and lets filesystem failures propagate to the caller. */
export function ensureMissionRootStrict(store: Store, mission: Mission): Mission {
  let current = mission
  if (!current.rootPath) {
    const baseDir = resolveMissionsBaseDir(store.getSettings().workspaceDir, os.homedir())
    current =
      store.setMissionRootPath(current.id, resolveMissionRootPath(baseDir, current.name)) ?? current
  }
  ensureMissionRoot({
    rootPath: current.rootPath!,
    links: getLocalMissionMemberLinks(store, current)
  })
  return current
}

/** Best-effort sync on member mutations: the root is a convenience view and
 *  must never fail the underlying mission operation. */
export function syncMissionRootIfPresent(store: Store, missionId: string): void {
  const mission = store.getMission(missionId)
  if (!mission?.rootPath) {
    return
  }
  try {
    ensureMissionRoot({
      rootPath: mission.rootPath,
      links: getLocalMissionMemberLinks(store, mission)
    })
  } catch (error) {
    console.warn('[missions] mission root sync failed:', error)
  }
}

export function removeMissionRootIfPresent(mission: Mission): void {
  if (!mission.rootPath) {
    return
  }
  try {
    removeMissionRoot(mission.rootPath)
  } catch (error) {
    console.warn('[missions] mission root removal failed:', error)
  }
}
