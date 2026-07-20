import os from 'node:os'
import path from 'node:path'
import type { Mission } from '../../shared/types'
import { getMissionRootDirName } from '../../shared/missions'
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import {
  ensureMissionRoot,
  MISSIONS_DIR_NAME,
  removeMissionRoot,
  resolveMissionRootPath,
  resolveMissionsBaseDir,
  type RemoveMissionRootResult,
  type MissionRootLink
} from './mission-root'
import { hasMissionWorktreeOwnershipMarker } from './mission-worktree-ownership-marker'

function getConfiguredMissionsBaseDir(store: Store): string {
  return resolveMissionsBaseDir(store.getSettings().workspaceDir, os.homedir())
}

function isMissionsBaseDir(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    path.basename(value).toLowerCase() === MISSIONS_DIR_NAME.toLowerCase()
  )
}

function resolveMissionBaseDir(store: Store, mission: Mission): string {
  if (mission.rootBasePath) {
    if (!isMissionsBaseDir(mission.rootBasePath)) {
      throw new Error('mission_root_invalid_base')
    }
    return mission.rootBasePath
  }
  if (mission.rootPath) {
    const inferred = path.dirname(mission.rootPath)
    // Why: pre-rootBasePath Missions can be adopted only from the exact
    // historical `missions` parent; marker ownership is still checked below.
    if (isMissionsBaseDir(inferred)) {
      return inferred
    }
  }
  return getConfiguredMissionsBaseDir(store)
}

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
    const meta = store.getWorktreeMeta(member.worktreeId)
    // Why: worktree paths and persisted member pointers are mutable; all three
    // ownership stamps must agree before exposing a filesystem link.
    if (
      !parsed ||
      parsed.repoId !== member.repoId ||
      !member.worktreeInstanceId ||
      meta?.missionId !== mission.id ||
      meta?.instanceId !== member.worktreeInstanceId
    ) {
      continue
    }
    if (
      !hasMissionWorktreeOwnershipMarker({
        repoPath: repo.path,
        worktreePath: parsed.worktreePath,
        proof: {
          missionId: mission.id,
          repoId: member.repoId,
          worktreeId: member.worktreeId,
          worktreeInstanceId: member.worktreeInstanceId
        }
      })
    ) {
      continue
    }
    if (
      mission.rootPath &&
      areWorktreePathsEqual(path.dirname(parsed.worktreePath), mission.rootPath)
    ) {
      // New Missions place real worktrees directly beneath the session root;
      // only legacy out-of-root members need a compatibility link.
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
  const baseDir = resolveMissionBaseDir(store, current)
  if (!current.rootPath) {
    current =
      store.setMissionRootPath(
        current.id,
        resolveMissionRootPath(baseDir, current.name, current.id),
        baseDir
      ) ?? current
  } else if (!current.rootBasePath) {
    current = store.setMissionRootPath(current.id, current.rootPath, baseDir) ?? current
  }
  ensureMissionRoot({
    baseDir,
    rootPath: current.rootPath!,
    missionId: current.id,
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
    const baseDir = resolveMissionBaseDir(store, mission)
    ensureMissionRoot({
      baseDir,
      rootPath: mission.rootPath,
      missionId: mission.id,
      links: getLocalMissionMemberLinks(store, mission)
    })
  } catch (error) {
    console.warn('[missions] mission root sync failed:', error)
  }
}

export function removeMissionRootIfPresent(
  store: Store,
  mission: Mission
): RemoveMissionRootResult | null {
  if (!mission.rootPath) {
    return null
  }
  const baseDir = resolveMissionBaseDir(store, mission)
  const result = removeMissionRoot({
    baseDir,
    rootPath: mission.rootPath,
    missionId: mission.id
  })
  if (!result.removed) {
    console.warn(
      `[missions] preserved non-empty mission root ${mission.rootPath}:`,
      result.preservedEntries
    )
  }
  return result
}
