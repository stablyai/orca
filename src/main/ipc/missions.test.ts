import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../shared/types'

const missionsBaseDir = path.join(path.sep, 'home', 'u', 'orca', 'missions')
const referralRootPath = path.join(missionsBaseDir, 'referral')
const workspacesDir = path.join(path.sep, 'home', 'u', 'orca', 'workspaces')
const wtPath = path.join(path.sep, 'wt')
const wtLocalPath = path.join(path.sep, 'wt', 'local')
const wtRemotePath = path.join(path.sep, 'wt', 'remote')

const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  },
  BrowserWindow: class {}
}))

const missionRootMocks = vi.hoisted(() => ({
  ensureMissionRoot: vi.fn(),
  removeMissionRoot: vi.fn(),
  resolveMissionRootPath: vi.fn((baseDir: string, name: string) =>
    path.join(baseDir, name.toLowerCase())
  ),
  resolveMissionsBaseDir: vi.fn(() => missionsBaseDir)
}))

vi.mock('../missions/mission-root', () => missionRootMocks)

import { registerMissionHandlers } from './missions'

function makeFakeStore() {
  let mission: Mission | null = null
  let sessionWorkspace: { id: string; missionId: string } | null = null
  return {
    getRepo: (id: string) =>
      id === 'r1'
        ? { id, displayName: 'Repo One' }
        : id === 'r2'
          ? { id, displayName: 'Repo Two', connectionId: 'ssh-1' }
          : null,
    getSettings: () => ({ workspaceDir: workspacesDir }),
    setMissionRootPath: vi.fn((_id: string, rootPath: string) => {
      if (mission) {
        mission.rootPath = rootPath
      }
      return mission
    }),
    getMissionSessionWorkspace: (missionId: string) =>
      sessionWorkspace?.missionId === missionId ? sessionWorkspace : null,
    ensureMissionSessionWorkspace: vi.fn((missionId: string) => {
      sessionWorkspace ??= { id: 'fw-1', missionId }
      return sessionWorkspace
    }),
    getMissions: () => (mission ? [mission] : []),
    getMission: (id: string) => (mission?.id === id ? mission : null),
    createMission: (input: {
      name: string
      branchName?: string | null
      repoIds: string[]
      sessionAgent?: Mission['sessionAgent']
    }) => {
      mission = {
        id: 'm1',
        name: input.name,
        branchName: input.branchName ?? 'mission/referral',
        members: input.repoIds.map((repoId) => ({ repoId, worktreeId: null, addedAt: 1 })),
        tabOrder: 0,
        ...(input.sessionAgent ? { sessionAgent: input.sessionAgent } : {}),
        createdAt: 1,
        updatedAt: 1
      }
      return mission
    },
    updateMission: vi.fn(() => mission),
    deleteMission: vi.fn(() => {
      mission = null
      return true
    }),
    addMissionMembers: vi.fn((_id: string, repoIds: string[]) => {
      if (mission) {
        for (const repoId of repoIds) {
          if (!mission.members.some((m) => m.repoId === repoId)) {
            mission.members.push({ repoId, worktreeId: null, addedAt: 1 })
          }
        }
      }
      return mission
    }),
    removeMissionMember: vi.fn((_id: string, repoId: string) => {
      if (mission) {
        mission.members = mission.members.filter((m) => m.repoId !== repoId)
      }
      return mission
    }),
    setMissionMemberWorktree: vi.fn((_id: string, repoId: string, worktreeId: string | null) => {
      const member = mission?.members.find((m) => m.repoId === repoId)
      if (member) {
        member.worktreeId = worktreeId
      }
      return mission
    })
  }
}

function makeFakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}

describe('missions IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('rejects malformed create args', async () => {
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, makeFakeStore() as never, runtime as never)
    await expect(handlers.get('missions:create')!({}, { name: '' })).rejects.toThrow(
      'invalid_mission_create_args'
    )
  })

  it('creates worktrees per member and records partial failures without rollback', async () => {
    const store = makeFakeStore()
    const runtime = {
      createManagedWorktree: vi
        .fn()
        .mockResolvedValueOnce({ worktree: { id: `r1::${wtPath}` } })
        .mockRejectedValueOnce(new Error('Branch "mission/referral" already exists locally.')),
      removeManagedWorktree: vi.fn()
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    const result = (await handlers.get('missions:create')!(
      {},
      { name: 'Referral', repoIds: ['r1', 'r2', 'ghost'] }
    )) as { mission: Mission; memberResults: unknown[] }
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoSelector: 'id:r1', branchNameOverride: 'mission/referral' })
    )
    expect(result.memberResults).toEqual([
      { repoId: 'r1', worktreeId: `r1::${wtPath}` },
      { repoId: 'r2', worktreeId: null, error: expect.stringContaining('already exists') }
    ])
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith('m1', 'r1', `r1::${wtPath}`)
  })

  it('delete keeps the mission when a worktree removal fails', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    store.setMissionMemberWorktree('m1', 'r1', `r1::${wtPath}`)
    store.setMissionMemberWorktree('m1', 'r2', `r2::${wtPath}`)
    const runtime = {
      createManagedWorktree: vi.fn(),
      removeManagedWorktree: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('uncommitted changes'))
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean; memberResults: { error?: string }[] }
    expect(result.deleted).toBe(false)
    expect(result.memberResults.some((entry) => entry.error)).toBe(true)
    expect(store.deleteMission).not.toHaveBeenCalled()
  })

  it('applies the session agent from create args and ensures the session', async () => {
    const store = makeFakeStore()
    const runtime = {
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: `r1::${wtPath}` } }),
      removeManagedWorktree: vi.fn()
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    await handlers.get('missions:create')!(
      {},
      {
        name: 'Referral',
        repoIds: ['r1'],
        sessionAgent: 'claude'
      }
    )
    expect(store.getMission('m1')?.sessionAgent).toBe('claude')
    expect(store.ensureMissionSessionWorkspace).toHaveBeenCalledWith('m1')
  })

  it('ensureSession resolves the root once, links only local members, and is idempotent', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    store.setMissionMemberWorktree('m1', 'r1', `r1::${wtLocalPath}`)
    store.setMissionMemberWorktree('m1', 'r2', `r2::${wtRemotePath}`)
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const workspace = (await handlers.get('missions:ensureSession')!({}, { missionId: 'm1' })) as {
      id: string
      missionId: string
    }
    expect(workspace).toEqual({ id: 'fw-1', missionId: 'm1' })
    expect(store.setMissionRootPath).toHaveBeenCalledWith('m1', referralRootPath)
    expect(missionRootMocks.ensureMissionRoot).toHaveBeenCalledWith({
      rootPath: referralRootPath,
      // Why: the ssh-connection member (r2) must not be linked into the root.
      links: [{ name: 'repo-one', targetPath: wtLocalPath }]
    })

    await handlers.get('missions:ensureSession')!({}, { missionId: 'm1' })
    expect(store.setMissionRootPath).toHaveBeenCalledTimes(1)
    expect(store.ensureMissionSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('delete removes the mission root when the record is deleted', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    await handlers.get('missions:delete')!({}, { missionId: 'm1', deleteWorktrees: false })
    expect(missionRootMocks.removeMissionRoot).toHaveBeenCalledWith(referralRootPath)
  })

  it('delete without worktrees just removes the record', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean }
    expect(result.deleted).toBe(true)
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('addMembers only fans out new repos and syncs the mission root', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionMemberWorktree('m1', 'r1', `r1::${wtPath}`)
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = {
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: `r2::${wtPath}` } }),
      removeManagedWorktree: vi.fn()
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:addMembers')!(
      {},
      // r1 is already a member; ghost has no repo — both are filtered out.
      { missionId: 'm1', repoIds: ['r1', 'r2', 'ghost'] }
    )) as { memberResults: unknown[] }

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoSelector: 'id:r2' })
    )
    expect(result.memberResults).toEqual([{ repoId: 'r2', worktreeId: `r2::${wtPath}` }])
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith('m1', 'r2', `r2::${wtPath}`)
    // Root sync ran with the (now local) members that have worktrees.
    expect(missionRootMocks.ensureMissionRoot).toHaveBeenCalled()
  })

  it('removeMember deletes the worktree and drops the member when asked', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionMemberWorktree('m1', 'r1', `r1::${wtPath}`)
    const runtime = {
      createManagedWorktree: vi.fn(),
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: true }
    )) as { deleted: boolean; memberResults: { repoId: string; worktreeId: string | null }[] }

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(`id:r1::${wtPath}`, false, true)
    expect(store.removeMissionMember).toHaveBeenCalledWith('m1', 'r1')
    expect(result.deleted).toBe(false)
    expect(result.memberResults).toEqual([{ repoId: 'r1', worktreeId: null }])
  })

  it('removeMember keeps the worktree when deleteWorktree is false', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionMemberWorktree('m1', 'r1', `r1::${wtPath}`)
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: false }
    )

    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(store.removeMissionMember).toHaveBeenCalledWith('m1', 'r1')
  })

  it('recreateMemberWorktree recreates the worktree for an existing member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = {
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: `r1::${wtPath}` } }),
      removeManagedWorktree: vi.fn()
    }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:recreateMemberWorktree')!(
      {},
      { missionId: 'm1', repoId: 'r1' }
    )) as { repoId: string; worktreeId: string | null }

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoSelector: 'id:r1' })
    )
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith('m1', 'r1', `r1::${wtPath}`)
    expect(result).toEqual({ repoId: 'r1', worktreeId: `r1::${wtPath}` })
  })

  it('recreateMemberWorktree rejects an unknown member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = { createManagedWorktree: vi.fn(), removeManagedWorktree: vi.fn() }
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await expect(
      handlers.get('missions:recreateMemberWorktree')!({}, { missionId: 'm1', repoId: 'ghost' })
    ).rejects.toThrow('mission_member_not_found')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
