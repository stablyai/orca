import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import type {
  Mission,
  MissionCreateResult,
  MissionDeleteResult,
  MissionMemberResult
} from '../../shared/types'
import { getMissionWorktreeName } from '../../shared/missions'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const MissionCreateArgs = z.object({
  name: z.string().min(1),
  branchName: z.string().min(1).optional(),
  repoIds: z.array(z.string().min(1)).min(1)
})

const MissionUpdateArgs = z.object({
  missionId: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    tabOrder: z.number().finite().optional()
  })
})

const MissionDeleteArgs = z.object({
  missionId: z.string().min(1),
  deleteWorktrees: z.boolean()
})

const MissionAddMembersArgs = z.object({
  missionId: z.string().min(1),
  repoIds: z.array(z.string().min(1)).min(1)
})

const MissionRemoveMemberArgs = z.object({
  missionId: z.string().min(1),
  repoId: z.string().min(1),
  deleteWorktree: z.boolean()
})

const MissionMemberSelectorArgs = z.object({
  missionId: z.string().min(1),
  repoId: z.string().min(1)
})

function parseMissionIpcArgs<T>(schema: z.ZodType<T>, value: unknown, errorCode: string): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  throw new Error(errorCode)
}

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
  'missions:recreateMemberWorktree'
] as const

export function registerMissionHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  for (const channel of MISSION_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  async function createMemberWorktree(
    mission: Mission,
    repoId: string
  ): Promise<MissionMemberResult> {
    try {
      const created = await runtime.createManagedWorktree({
        repoSelector: `id:${repoId}`,
        name: getMissionWorktreeName(mission.branchName),
        displayName: mission.name,
        branchNameOverride: mission.branchName
      })
      store.setMissionMemberWorktree(mission.id, repoId, created.worktree.id)
      return { repoId, worktreeId: created.worktree.id }
    } catch (error) {
      store.setMissionMemberWorktree(mission.id, repoId, null)
      return { repoId, worktreeId: null, error: toErrorMessage(error) }
    }
  }

  // Why: fan-out is intentionally sequential — parallel worktree creation can
  // contend on git locks, and per-member results must stay deterministic for
  // the create dialog.
  async function createMemberWorktrees(
    mission: Mission,
    repoIds: string[]
  ): Promise<MissionMemberResult[]> {
    const results: MissionMemberResult[] = []
    for (const repoId of repoIds) {
      results.push(await createMemberWorktree(mission, repoId))
    }
    return results
  }

  async function removeMemberWorktree(
    mission: Mission,
    member: { repoId: string; worktreeId: string | null }
  ): Promise<MissionMemberResult> {
    if (!member.worktreeId) {
      store.removeMissionMember(mission.id, member.repoId)
      return { repoId: member.repoId, worktreeId: null }
    }
    try {
      await runtime.removeManagedWorktree(`id:${member.worktreeId}`, false, true)
      store.removeMissionMember(mission.id, member.repoId)
      return { repoId: member.repoId, worktreeId: null }
    } catch (error) {
      return { repoId: member.repoId, worktreeId: member.worktreeId, error: toErrorMessage(error) }
    }
  }

  ipcMain.handle('missions:list', (): Mission[] => store.getMissions())

  ipcMain.handle(
    'missions:create',
    async (_event, rawArgs: unknown): Promise<MissionCreateResult> => {
      const args = parseMissionIpcArgs(MissionCreateArgs, rawArgs, 'invalid_mission_create_args')
      const repoIds = [...new Set(args.repoIds)].filter((repoId) => store.getRepo(repoId))
      if (repoIds.length === 0) {
        throw new Error('mission_create_no_valid_repos')
      }
      const mission = store.createMission({
        name: args.name,
        branchName: args.branchName ?? null,
        repoIds
      })
      notifyReposChanged(mainWindow)
      const memberResults = await createMemberWorktrees(mission, repoIds)
      notifyReposChanged(mainWindow)
      return { mission: store.getMission(mission.id) ?? mission, memberResults }
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
      const mission = store.getMission(args.missionId)
      if (!mission) {
        return { deleted: false, memberResults: [] }
      }
      if (!args.deleteWorktrees) {
        const deleted = store.deleteMission(mission.id)
        notifyReposChanged(mainWindow)
        return { deleted, memberResults: [] }
      }
      const memberResults: MissionMemberResult[] = []
      // Why: removeMissionMember reassigns mission.members; iterate the array
      // captured before the loop so removals don't skip entries.
      const members = mission.members
      for (const member of members) {
        memberResults.push(await removeMemberWorktree(mission, member))
      }
      const remaining = store.getMission(mission.id)
      // Why: a mission with an undeletable worktree (dirty/unpushed) must stay
      // visible so the user can resolve and retry — never silently orphan it.
      const deleted =
        remaining !== null && remaining.members.length === 0
          ? store.deleteMission(mission.id)
          : false
      notifyReposChanged(mainWindow)
      return { deleted, memberResults }
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
      const mission = store.getMission(args.missionId)
      if (!mission) {
        throw new Error('mission_not_found')
      }
      const existing = new Set(mission.members.map((member) => member.repoId))
      const repoIds = [...new Set(args.repoIds)].filter(
        (repoId) => store.getRepo(repoId) && !existing.has(repoId)
      )
      store.addMissionMembers(mission.id, repoIds)
      notifyReposChanged(mainWindow)
      const memberResults = await createMemberWorktrees(
        store.getMission(mission.id) ?? mission,
        repoIds
      )
      notifyReposChanged(mainWindow)
      return { mission: store.getMission(mission.id) ?? mission, memberResults }
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
      const mission = store.getMission(args.missionId)
      if (!mission) {
        return { deleted: false, memberResults: [] }
      }
      const member = mission.members.find((entry) => entry.repoId === args.repoId)
      if (!member) {
        return { deleted: false, memberResults: [] }
      }
      let result: MissionMemberResult
      if (args.deleteWorktree) {
        result = await removeMemberWorktree(mission, member)
      } else {
        store.removeMissionMember(mission.id, member.repoId)
        result = { repoId: member.repoId, worktreeId: null }
      }
      notifyReposChanged(mainWindow)
      return { deleted: false, memberResults: [result] }
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
      const mission = store.getMission(args.missionId)
      if (!mission || !mission.members.some((member) => member.repoId === args.repoId)) {
        throw new Error('mission_member_not_found')
      }
      const result = await createMemberWorktree(mission, args.repoId)
      notifyReposChanged(mainWindow)
      return result
    }
  )
}
