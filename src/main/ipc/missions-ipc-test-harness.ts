import path from 'node:path'
import { vi } from 'vitest'
import type { Mission } from '../../shared/types'
import type {
  FakeMissionCreateInput,
  FakeStore,
  FakeWindow,
  FakeWorktreeMeta,
  MissionRootMockSet,
  OwnershipMarkerMockSet
} from './missions-ipc-test-contracts'

export const missionsBaseDir = path.join(path.sep, 'home', 'u', 'orca', 'missions')
export const referralRootPath = path.join(missionsBaseDir, 'referral')
const workspacesDir = path.join(path.sep, 'home', 'u', 'orca', 'workspaces')
export const wtR1Path = path.join(path.sep, 'wt', 'r1')
export const wtR2Path = path.join(path.sep, 'wt', 'r2')

const missionRootMocks = vi.hoisted(() => ({
  MISSIONS_DIR_NAME: 'missions',
  ensureMissionRoot: vi.fn(),
  removeMissionRoot: vi.fn(() => ({ removed: true, preservedEntries: [] })),
  resolveMissionRootPath: vi.fn((baseDir: string, name: string) =>
    path.join(baseDir, name.toLowerCase())
  ),
  resolveMissionsBaseDir: vi.fn(() => missionsBaseDir)
}))

vi.mock('../missions/mission-root', () => missionRootMocks)

const ownershipMarkerMocks = vi.hoisted(() => ({
  assertMissionWorktreeOwnershipMarker: vi.fn(),
  hasMissionWorktreeOwnershipMarker: vi.fn(() => true),
  removeMissionWorktreeOwnershipMarker: vi.fn()
}))

vi.mock('../missions/mission-worktree-ownership-marker', () => ownershipMarkerMocks)

export function getMissionRootMocks(): MissionRootMockSet {
  return missionRootMocks
}

export function getOwnershipMarkerMocks(): OwnershipMarkerMockSet {
  return ownershipMarkerMocks
}

export function worktreePathForRepo(repoId: string): string {
  return repoId === 'r1' ? wtR1Path : wtR2Path
}

export function worktreeIdForRepo(repoId: string): string {
  return `${repoId}::${worktreePathForRepo(repoId)}`
}

export function instanceIdForRepo(repoId: string): string {
  return `instance-${repoId}`
}

export function ownershipProofForRepo(repoId: string) {
  return {
    missionId: 'm1',
    repoId,
    worktreeId: worktreeIdForRepo(repoId),
    worktreeInstanceId: instanceIdForRepo(repoId)
  }
}

export function makeFakeStore(): FakeStore {
  let mission: Mission | null = null
  let sessionWorkspace: { id: string; missionId: string } | null = null
  const worktreeMeta: Record<string, FakeWorktreeMeta> = {}
  const flushOrThrow = vi.fn()
  const deleteMission = vi.fn(() => {
    if (!mission) {
      return false
    }
    mission = null
    sessionWorkspace = null
    return true
  })
  const deleteMissionAndFlush = vi.fn(() => {
    const missionSnapshot = mission
    const sessionWorkspaceSnapshot = sessionWorkspace
    const deleted = deleteMission()
    if (!deleted) {
      return false
    }
    try {
      flushOrThrow()
      return true
    } catch (error) {
      mission = missionSnapshot
      sessionWorkspace = sessionWorkspaceSnapshot
      throw error
    }
  })

  return {
    getRepo: (id: string) => {
      if (id === 'r1' || id === 'r2') {
        return {
          id,
          path: path.join(path.sep, 'repos', id),
          displayName: id === 'r1' ? 'Repo One' : 'Repo Two',
          badgeColor: '#000',
          addedAt: 1,
          kind: 'git' as const,
          connectionId: null,
          executionHostId: 'local' as const
        }
      }
      if (id === 'ssh') {
        return {
          id,
          path: path.join(path.sep, 'srv', 'ssh'),
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 1,
          kind: 'git' as const,
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1' as const
        }
      }
      return null
    },
    getProjects: () => [],
    getSettings: () => ({ workspaceDir: workspacesDir }),
    flushOrThrow,
    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (worktreeId: string) => worktreeMeta[worktreeId],
    setWorktreeMeta: vi.fn((worktreeId: string, updates: FakeWorktreeMeta) => {
      worktreeMeta[worktreeId] = { ...worktreeMeta[worktreeId], ...updates }
      return worktreeMeta[worktreeId]
    }),
    setMissionRootPath: vi.fn((_id: string, rootPath: string, rootBasePath?: string | null) => {
      if (mission) {
        mission.rootPath = rootPath
        if (rootBasePath !== undefined) {
          mission.rootBasePath = rootBasePath
        }
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
    createMission: (input: FakeMissionCreateInput) => {
      mission = {
        id: 'm1',
        name: input.name,
        branchName: input.branchName ?? 'mission/referral',
        members: input.repoIds.map((repoId) => ({
          repoId,
          worktreeId: null,
          worktreeInstanceId: null,
          lastError: null,
          addedAt: 1
        })),
        tabOrder: 0,
        ...(input.sessionAgent ? { sessionAgent: input.sessionAgent } : {}),
        createdAt: 1,
        updatedAt: 1
      }
      return mission
    },
    updateMission: vi.fn(() => mission),
    deleteMission,
    deleteMissionAndFlush,
    addMissionMembers: vi.fn((_id: string, repoIds: string[]) => {
      if (mission) {
        for (const repoId of repoIds) {
          if (!mission.members.some((member) => member.repoId === repoId)) {
            mission.members.push({
              repoId,
              worktreeId: null,
              worktreeInstanceId: null,
              lastError: null,
              addedAt: 1
            })
          }
        }
      }
      return mission
    }),
    removeMissionMember: vi.fn((_id: string, repoId: string) => {
      if (mission) {
        mission.members = mission.members.filter((member) => member.repoId !== repoId)
      }
      return mission
    }),
    setMissionMemberWorktree: vi.fn(
      (
        _id: string,
        repoId: string,
        worktreeId: string | null,
        worktreeInstanceId: string | null = null
      ) => {
        const member = mission?.members.find((entry) => entry.repoId === repoId)
        if (member) {
          member.worktreeId = worktreeId
          member.worktreeInstanceId = worktreeInstanceId
          member.lastError = null
        }
        return mission
      }
    ),
    setMissionMemberError: vi.fn((_id: string, repoId: string, error: string | null) => {
      const member = mission?.members.find((entry) => entry.repoId === repoId)
      if (member) {
        member.lastError = error
      }
      return mission
    })
  }
}

type CreateWorktreeArgs = {
  repoSelector: string
  branchNameOverride: string
  missionId: string
}

export function createStampedWorktree(store: FakeStore, args: CreateWorktreeArgs) {
  const repoId = args.repoSelector.slice('id:'.length)
  const id = worktreeIdForRepo(repoId)
  const instanceId = instanceIdForRepo(repoId)
  store.setWorktreeMeta(id, { instanceId, missionId: args.missionId })
  return {
    worktree: {
      id,
      path: worktreePathForRepo(repoId),
      repoId,
      branch: args.branchNameOverride,
      instanceId
    }
  }
}

export function makeFakeRuntime(store: FakeStore) {
  return {
    createManagedWorktree: vi.fn(async (args: CreateWorktreeArgs) =>
      createStampedWorktree(store, args)
    ),
    inspectManagedWorktreeForOwnership: vi.fn(async (id: string): Promise<unknown> => {
      const meta = store.getWorktreeMeta(id)
      if (!meta?.instanceId) {
        return { status: 'missing' as const }
      }
      return {
        status: 'found' as const,
        worktree: {
          id,
          path: id.slice(id.indexOf('::') + 2),
          repoId: id.split('::', 1)[0],
          branch: store.getMissions()[0]?.branchName ?? 'mission/referral',
          instanceId: meta.instanceId
        }
      }
    }),
    findManagedWorktreesForMissionOwnership: vi.fn(
      async (): Promise<
        | {
            status: 'found'
            candidates: ReturnType<typeof ownershipProofForRepo>[]
          }
        | {
            status: 'unavailable'
          }
      > => ({ status: 'found', candidates: [] })
    ),
    removeManagedWorktree: vi.fn(async () => ({})),
    teardownWorkspaceProcesses: vi.fn(async () => {})
  }
}

export function assignOwnedWorktree(
  store: FakeStore,
  repoId: string
): {
  worktreeId: string
  worktreeInstanceId: string
} {
  const worktreeId = worktreeIdForRepo(repoId)
  const worktreeInstanceId = instanceIdForRepo(repoId)
  store.setWorktreeMeta(worktreeId, { instanceId: worktreeInstanceId, missionId: 'm1' })
  store.setMissionMemberWorktree('m1', repoId, worktreeId, worktreeInstanceId)
  return { worktreeId, worktreeInstanceId }
}

export function makeFakeWindow(): FakeWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}
