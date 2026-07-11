import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../shared/types'

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

import { registerMissionHandlers } from './missions'

function makeFakeStore() {
  let mission: Mission | null = null
  return {
    getRepo: (id: string) => (['r1', 'r2'].includes(id) ? { id } : null),
    getMissions: () => (mission ? [mission] : []),
    getMission: (id: string) => (mission?.id === id ? mission : null),
    createMission: (input: { name: string; branchName?: string | null; repoIds: string[] }) => {
      mission = {
        id: 'm1',
        name: input.name,
        branchName: input.branchName ?? 'mission/referral',
        members: input.repoIds.map((repoId) => ({ repoId, worktreeId: null, addedAt: 1 })),
        tabOrder: 0,
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
    addMissionMembers: vi.fn(() => mission),
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
        .mockResolvedValueOnce({ worktree: { id: 'r1::/wt' } })
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
      { repoId: 'r1', worktreeId: 'r1::/wt' },
      { repoId: 'r2', worktreeId: null, error: expect.stringContaining('already exists') }
    ])
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith('m1', 'r1', 'r1::/wt')
  })

  it('delete keeps the mission when a worktree removal fails', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    store.setMissionMemberWorktree('m1', 'r1', 'r1::/wt')
    store.setMissionMemberWorktree('m1', 'r2', 'r2::/wt')
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
})
