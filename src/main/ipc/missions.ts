import { ipcMain, type BrowserWindow } from 'electron'
import {
  MissionAddMembersArgs,
  MissionCreateArgs,
  MissionDeleteArgs,
  MissionMemberSelectorArgs,
  MissionRemoveMemberArgs,
  MissionSelectorArgs,
  MissionUpdateArgs,
  parseMissionIpcArgs
} from './mission-ipc-args'
import type {
  FolderWorkspace,
  Mission,
  MissionCreateResult,
  MissionDeleteResult,
  MissionMemberResult
} from '../../shared/types'
import {
  ensureMissionRootStrict,
  removeMissionRootIfPresent,
  syncMissionRootIfPresent
} from '../missions/mission-root-sync'
import { MissionMemberLifecycle } from '../missions/mission-member-lifecycle'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requireNativeLocalMissionRepos } from '../missions/mission-repo-eligibility'

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MISSION_CHANNELS = [
  'missions:list',
  'missions:create',
  'missions:update',
  'missions:delete',
  'missions:addMembers',
  'missions:removeMember',
  'missions:recreateMemberWorktree',
  'missions:ensureSession'
] as const

export function registerMissionHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  for (const channel of MISSION_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  const memberLifecycle = new MissionMemberLifecycle(store, runtime)

  ipcMain.handle('missions:list', (): Mission[] => store.getMissions())

  ipcMain.handle(
    'missions:create',
    async (_event, rawArgs: unknown): Promise<MissionCreateResult> => {
      const args = parseMissionIpcArgs(MissionCreateArgs, rawArgs, 'invalid_mission_create_args')
      const repoIds = [...new Set(args.repoIds)]
      requireNativeLocalMissionRepos(store, repoIds)
      const mission = store.createMission({
        name: args.name,
        branchName: args.branchName ?? null,
        repoIds,
        sessionAgent: args.sessionAgent
      })
      return memberLifecycle.run(mission.id, async () => {
        let rootedMission: Mission | null = null
        try {
          // Why: member worktrees live inside the Mission root so sandboxed
          // agents can discover and edit every repo without following external symlinks.
          rootedMission = ensureMissionRootStrict(store, mission)
          // Why: the worktree marker can recover metadata/member-pointer crash
          // windows only if the owning Mission and root already reached disk.
          store.flushOrThrow()
        } catch (error) {
          if (rootedMission) {
            try {
              removeMissionRootIfPresent(store, rootedMission)
            } catch {
              // Preserve the original durability failure; ownership checks keep
              // an unremoved root from being claimed by another Mission.
            }
          }
          store.deleteMission(mission.id)
          throw error
        }
        notifyReposChanged(mainWindow)
        const memberResults = await memberLifecycle.createWorktrees(rootedMission, repoIds)
        store.ensureMissionSessionWorkspace(rootedMission.id)
        notifyReposChanged(mainWindow)
        return { mission: store.getMission(mission.id) ?? rootedMission, memberResults }
      })
    }
  )
  ipcMain.handle('missions:update', (_event, rawArgs: unknown): Mission | null => {
    const args = parseMissionIpcArgs(MissionUpdateArgs, rawArgs, 'invalid_mission_update_args')
    const updated = store.updateMission(args.missionId, args.updates)
    if (updated) {
      notifyReposChanged(mainWindow)
    }
    return updated
  })
  ipcMain.handle(
    'missions:delete',
    async (_event, rawArgs: unknown): Promise<MissionDeleteResult> => {
      const args = parseMissionIpcArgs(MissionDeleteArgs, rawArgs, 'invalid_mission_delete_args')
      return memberLifecycle.run(args.missionId, async () => {
        const mission = store.getMission(args.missionId)
        if (!mission) {
          return { deleted: false, memberResults: [] }
        }
        try {
          // Why: the Mission PTY may have a cwd inside a link; stop it before unlinking.
          await memberLifecycle.teardownSession(mission)
        } catch (error) {
          return { deleted: false, memberResults: [], error: toErrorMessage(error) }
        }

        if (!args.deleteWorktrees) {
          let rootWarning: string | undefined, recoveredMission: Mission, deleted: boolean
          try {
            // Why: a create intent may be the only proof after Git add. Promote
            // it through a strict scan before root cleanup can remove that proof.
            recoveredMission = await memberLifecycle.recoverMembersBeforeMissionDetach(mission)
            const rootResult = removeMissionRootIfPresent(store, recoveredMission)
            if (rootResult && !rootResult.removed && mission.rootPath) {
              rootWarning = `Preserved files in the former Mission root: ${mission.rootPath}`
            }
            // Why: marker removal is safe only after Mission/session deletion is durable.
            deleted = store.deleteMissionAndFlush(mission.id)
          } catch (error) {
            return { deleted: false, memberResults: [], error: toErrorMessage(error) }
          }
          if (deleted) {
            memberLifecycle.detachDeletedMissionOwnership(recoveredMission)
          }
          notifyReposChanged(mainWindow)
          return {
            deleted,
            memberResults: [],
            ...(rootWarning ? { warning: rootWarning } : {})
          }
        }

        const memberResults: MissionMemberResult[] = []
        // Why: removeWorktree reassigns members; iterate a snapshot so removals don't skip entries.
        const members = [...mission.members]
        for (const member of members) {
          memberResults.push(await memberLifecycle.removeWorktree(mission, member))
        }
        const remaining = store.getMission(mission.id)
        // Why: keep a Mission with an undeletable worktree visible for a safe retry.
        let deleted = false
        let rootWarning: string | undefined
        if (remaining !== null && remaining.members.length === 0) {
          try {
            const rootResult = removeMissionRootIfPresent(store, mission)
            if (rootResult && !rootResult.removed && mission.rootPath) {
              rootWarning = `Preserved files in the former Mission root: ${mission.rootPath}`
            }
            deleted = store.deleteMission(mission.id)
          } catch (error) {
            return {
              deleted: false,
              memberResults,
              error: toErrorMessage(error)
            }
          }
        }
        if (!deleted) {
          syncMissionRootIfPresent(store, mission.id)
        }
        notifyReposChanged(mainWindow)
        const warnings = memberResults.flatMap((result) => result.warning ?? [])
        if (rootWarning) {
          warnings.push(rootWarning)
        }
        return {
          deleted,
          memberResults,
          ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
        }
      })
    }
  )
  ipcMain.handle(
    'missions:addMembers',
    async (_event, rawArgs: unknown): Promise<MissionCreateResult> => {
      const args = parseMissionIpcArgs(
        MissionAddMembersArgs,
        rawArgs,
        'invalid_mission_add_members_args'
      )
      return memberLifecycle.run(args.missionId, async () => {
        const mission = store.getMission(args.missionId)
        if (!mission) {
          throw new Error('mission_not_found')
        }
        const existing = new Set(mission.members.map((member) => member.repoId))
        const repoIds = [...new Set(args.repoIds)].filter((repoId) => !existing.has(repoId))
        if (repoIds.length > 0) {
          requireNativeLocalMissionRepos(store, repoIds)
        }
        const rootedMission = ensureMissionRootStrict(store, mission)
        store.addMissionMembers(mission.id, repoIds)
        try {
          // Why: marker-only recovery needs the intended membership durable
          // before any newly added repo receives a linked checkout.
          store.flushOrThrow()
        } catch (error) {
          for (const repoId of repoIds) {
            store.removeMissionMember(mission.id, repoId)
          }
          throw error
        }
        notifyReposChanged(mainWindow)
        const memberResults = await memberLifecycle.createWorktrees(
          store.getMission(mission.id) ?? rootedMission,
          repoIds
        )
        syncMissionRootIfPresent(store, mission.id)
        notifyReposChanged(mainWindow)
        return { mission: store.getMission(mission.id) ?? mission, memberResults }
      })
    }
  )
  ipcMain.handle(
    'missions:removeMember',
    async (_event, rawArgs: unknown): Promise<MissionDeleteResult> => {
      const args = parseMissionIpcArgs(
        MissionRemoveMemberArgs,
        rawArgs,
        'invalid_mission_remove_member_args'
      )
      return memberLifecycle.run(args.missionId, async () => {
        const mission = store.getMission(args.missionId)
        if (!mission) {
          return { deleted: false, memberResults: [] }
        }
        const member = mission.members.find((entry) => entry.repoId === args.repoId)
        if (!member) {
          return { deleted: false, memberResults: [] }
        }
        try {
          await memberLifecycle.teardownSession(mission)
        } catch (error) {
          return {
            deleted: false,
            memberResults: [
              {
                repoId: member.repoId,
                worktreeId: member.worktreeId,
                error: toErrorMessage(error)
              }
            ]
          }
        }
        const result = args.deleteWorktree
          ? await memberLifecycle.removeWorktree(mission, member)
          : await memberLifecycle.detachMember(mission, member)
        syncMissionRootIfPresent(store, mission.id)
        notifyReposChanged(mainWindow)
        return { deleted: false, memberResults: [result] }
      })
    }
  )
  ipcMain.handle(
    'missions:recreateMemberWorktree',
    async (_event, rawArgs: unknown): Promise<MissionMemberResult> => {
      const args = parseMissionIpcArgs(
        MissionMemberSelectorArgs,
        rawArgs,
        'invalid_mission_recreate_args'
      )
      return memberLifecycle.run(args.missionId, async () => {
        const mission = store.getMission(args.missionId)
        if (!mission || !mission.members.some((member) => member.repoId === args.repoId)) {
          throw new Error('mission_member_not_found')
        }
        const rootedMission = ensureMissionRootStrict(store, mission)
        const result = await memberLifecycle.createWorktree(rootedMission, args.repoId)
        syncMissionRootIfPresent(store, mission.id)
        notifyReposChanged(mainWindow)
        return result
      })
    }
  )
  ipcMain.handle(
    'missions:ensureSession',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace> => {
      const args = parseMissionIpcArgs(
        MissionSelectorArgs,
        rawArgs,
        'invalid_mission_ensure_session_args'
      )
      return memberLifecycle.run(args.missionId, async () => {
        const mission = store.getMission(args.missionId)
        if (!mission) {
          throw new Error('mission_not_found')
        }
        requireNativeLocalMissionRepos(
          store,
          mission.members.map((member) => member.repoId)
        )
        // Why: session open must surface root creation failures; member-change syncs are best-effort.
        const ensured = ensureMissionRootStrict(store, mission)
        const workspace = store.ensureMissionSessionWorkspace(ensured.id)
        notifyReposChanged(mainWindow)
        return workspace
      })
    }
  )
}
