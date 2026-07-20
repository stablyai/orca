import type { Mock } from 'vitest'
import type { Mission } from '../../shared/types'

export type MissionRootMockSet = {
  MISSIONS_DIR_NAME: string
  ensureMissionRoot: Mock
  removeMissionRoot: Mock
  resolveMissionRootPath: Mock
  resolveMissionsBaseDir: Mock
}

export type OwnershipMarkerMockSet = {
  assertMissionWorktreeOwnershipMarker: Mock
  hasMissionWorktreeOwnershipMarker: Mock
  removeMissionWorktreeOwnershipMarker: Mock
}

export type FakeWorktreeMeta = {
  instanceId?: string
  missionId?: string
}

type FakeRepo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  kind: 'git'
  connectionId: string | null
  executionHostId: 'local' | `ssh:${string}`
}

type FakeMissionSessionWorkspace = {
  id: string
  missionId: string
}

export type FakeMissionCreateInput = {
  name: string
  branchName?: string | null
  repoIds: string[]
  sessionAgent?: Mission['sessionAgent']
}

export type FakeStore = {
  getRepo: (id: string) => FakeRepo | null
  getProjects: () => never[]
  getSettings: () => { workspaceDir: string }
  flushOrThrow: Mock<() => void>
  getAllWorktreeMeta: () => Record<string, FakeWorktreeMeta>
  getWorktreeMeta: (worktreeId: string) => FakeWorktreeMeta | undefined
  setWorktreeMeta: Mock<(worktreeId: string, updates: FakeWorktreeMeta) => FakeWorktreeMeta>
  setMissionRootPath: Mock<
    (id: string, rootPath: string, rootBasePath?: string | null) => Mission | null
  >
  getMissionSessionWorkspace: (missionId: string) => FakeMissionSessionWorkspace | null
  ensureMissionSessionWorkspace: Mock<(missionId: string) => FakeMissionSessionWorkspace>
  getMissions: () => Mission[]
  getMission: (id: string) => Mission | null
  createMission: (input: FakeMissionCreateInput) => Mission
  updateMission: Mock<() => Mission | null>
  deleteMission: Mock<() => boolean>
  deleteMissionAndFlush: Mock<() => boolean>
  addMissionMembers: Mock<(id: string, repoIds: string[]) => Mission | null>
  removeMissionMember: Mock<(id: string, repoId: string) => Mission | null>
  setMissionMemberWorktree: Mock<
    (
      id: string,
      repoId: string,
      worktreeId: string | null,
      worktreeInstanceId?: string | null
    ) => Mission | null
  >
  setMissionMemberError: Mock<(id: string, repoId: string, error: string | null) => Mission | null>
}

export type FakeWindow = {
  isDestroyed: () => boolean
  webContents: { send: Mock }
}
