import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../shared/types'
import {
  assignOwnedWorktree,
  createStampedWorktree,
  getMissionRootMocks,
  getOwnershipMarkerMocks,
  instanceIdForRepo,
  makeFakeRuntime,
  makeFakeStore,
  makeFakeWindow,
  missionsBaseDir,
  ownershipProofForRepo,
  referralRootPath,
  worktreeIdForRepo,
  worktreePathForRepo,
  wtR1Path,
  wtR2Path
} from './missions-ipc-test-harness'

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
import {
  assertRepoIsNotMissionManaged,
  assertWorktreeIsNotMissionManaged
} from '../missions/mission-removal-boundary'

const missionRootMocks = getMissionRootMocks()
const ownershipMarkerMocks = getOwnershipMarkerMocks()

describe('missions IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('rejects malformed create args', async () => {
    const store = makeFakeStore()
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)
    await expect(handlers.get('missions:create')!({}, { name: '' })).rejects.toThrow(
      'invalid_mission_create_args'
    )
  })

  it('rejects an invalid explicit branch before persisting the Mission', async () => {
    const store = makeFakeStore()
    const createMission = vi.spyOn(store, 'createMission')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await expect(
      handlers.get('missions:create')!(
        {},
        {
          name: 'Referral',
          branchName: 'mission/bad..ref',
          repoIds: ['r1']
        }
      )
    ).rejects.toThrow('invalid_mission_create_args')
    expect(createMission).not.toHaveBeenCalled()
    expect(store.getMissions()).toEqual([])
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'SSH', repoIds: ['r1', 'ssh'] },
    { label: 'missing', repoIds: ['r1', 'ghost'] }
  ])('rejects a create request containing an $label repo', async ({ repoIds }) => {
    const store = makeFakeStore()
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await expect(
      handlers.get('missions:create')!({}, { name: 'Referral', repoIds })
    ).rejects.toThrow('mission_native_local_git_repos_only')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(store.getMissions()).toEqual([])
  })

  it('creates worktrees per member and records partial failures without rollback', async () => {
    const store = makeFakeStore()
    const runtime = makeFakeRuntime(store)
    runtime.createManagedWorktree.mockImplementation(async (args) => {
      if (args.repoSelector === 'id:r2') {
        throw new Error('Branch "mission/referral" already exists locally.')
      }
      return createStampedWorktree(store, args)
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:create')!(
      {},
      { name: 'Referral', repoIds: ['r1', 'r2'] }
    )) as { mission: Mission; memberResults: unknown[] }

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
    expect(store.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.createManagedWorktree.mock.invocationCallOrder[0]
    )
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'id:r1',
      name: 'mission-referral-m1-r1',
      displayName: 'Repo One',
      branchNameOverride: 'mission/referral',
      requireExactBranchName: true,
      missionId: 'm1',
      worktreePathOverride: path.join(referralRootPath, 'repo-one-r1'),
      activate: false,
      skipInitialTerminal: true,
      runHooks: false,
      setupDecision: 'skip'
    })
    expect(result.memberResults).toEqual([
      {
        repoId: 'r1',
        worktreeId: worktreeIdForRepo('r1'),
        worktreeInstanceId: instanceIdForRepo('r1')
      },
      { repoId: 'r2', worktreeId: null, error: expect.stringContaining('already exists') }
    ])
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r1',
      worktreeIdForRepo('r1'),
      instanceIdForRepo('r1')
    )
    expect(result.mission.members.find((member) => member.repoId === 'r2')?.lastError).toContain(
      'already exists'
    )
  })

  it('delete keeps the mission and durable error when a worktree removal fails', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    assignOwnedWorktree(store, 'r1')
    assignOwnedWorktree(store, 'r2')
    const runtime = makeFakeRuntime(store)
    runtime.removeManagedWorktree
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('uncommitted changes'))
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean; memberResults: { error?: string }[] }

    expect(result.deleted).toBe(false)
    expect(result.memberResults.some((entry) => entry.error)).toBe(true)
    expect(runtime.removeManagedWorktree).toHaveBeenNthCalledWith(
      1,
      `id:${worktreeIdForRepo('r1')}`,
      false,
      false,
      ownershipProofForRepo('r1')
    )
    expect(runtime.removeManagedWorktree).toHaveBeenNthCalledWith(
      2,
      `id:${worktreeIdForRepo('r2')}`,
      false,
      false,
      ownershipProofForRepo('r2')
    )
    expect(store.getMission('m1')?.members[0].lastError).toBe('uncommitted changes')
    expect(store.deleteMission).not.toHaveBeenCalled()
  })

  it('delete recovers and removes a crash-window worktree before dropping its member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const worktreeId = worktreeIdForRepo('r1')
    store.setWorktreeMeta(worktreeId, {
      instanceId: instanceIdForRepo('r1'),
      missionId: 'm1'
    })
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean }

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${worktreeId}`,
      false,
      false,
      ownershipProofForRepo('r1')
    )
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r1',
      worktreeId,
      instanceIdForRepo('r1')
    )
    expect(result.deleted).toBe(true)
    expect(store.getMission('m1')).toBeNull()
  })

  it('deletes a member whose stale pointer is strictly proven missing', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const staleWorktreeId = worktreeIdForRepo('r1')
    store.setMissionMemberWorktree('m1', 'r1', staleWorktreeId, instanceIdForRepo('r1'))
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean }

    expect(runtime.inspectManagedWorktreeForOwnership).toHaveBeenCalledWith(staleWorktreeId)
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(result.deleted).toBe(true)
    expect(store.getMission('m1')).toBeNull()
  })

  it('delete fails closed when more than one live worktree carries member ownership', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    assignOwnedWorktree(store, 'r1')
    const extraId = `r1::${path.join(path.sep, 'wt', 'r1-extra')}`
    store.setWorktreeMeta(extraId, { instanceId: 'instance-extra', missionId: 'm1' })
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean; memberResults: { error?: string }[] }

    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(result.deleted).toBe(false)
    expect(result.memberResults[0].error).toBe('mission_member_owned_worktree_ambiguous')
    expect(store.getMission('m1')).not.toBeNull()
  })

  it('does not recover a stamped candidate on the wrong branch', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const worktreeId = worktreeIdForRepo('r1')
    store.setWorktreeMeta(worktreeId, {
      instanceId: instanceIdForRepo('r1'),
      missionId: 'm1'
    })
    const runtime = makeFakeRuntime(store)
    runtime.inspectManagedWorktreeForOwnership.mockResolvedValue({
      status: 'found',
      worktree: {
        id: worktreeId,
        path: worktreePathForRepo('r1'),
        repoId: 'r1',
        branch: 'refs/heads/not-the-mission',
        instanceId: instanceIdForRepo('r1')
      }
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean; memberResults: { error?: string }[] }

    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(result.deleted).toBe(false)
    expect(result.memberResults[0].error).toBe('mission_member_worktree_ownership_unverified')
  })

  it('keeps ownership and the member when the authoritative Git scan is unavailable', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const owned = assignOwnedWorktree(store, 'r1')
    const runtime = makeFakeRuntime(store)
    runtime.inspectManagedWorktreeForOwnership.mockResolvedValue({ status: 'unavailable' })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: true }
    )) as { deleted: boolean; memberResults: { error?: string }[] }

    expect(result.deleted).toBe(false)
    expect(result.memberResults[0].error).toBe('mission_member_worktree_liveness_unavailable')
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(store.getWorktreeMeta(owned.worktreeId)?.missionId).toBe('m1')
    expect(store.getMission('m1')?.members).toHaveLength(1)
  })

  it('applies the session agent from create args and ensures the session', async () => {
    const store = makeFakeStore()
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await handlers.get('missions:create')!(
      {},
      { name: 'Referral', repoIds: ['r1'], sessionAgent: 'claude' }
    )

    expect(store.getMission('m1')?.sessionAgent).toBe('claude')
    expect(store.ensureMissionSessionWorkspace).toHaveBeenCalledWith('m1')
  })

  it('ensureSession resolves the root once, links owned local members, and is idempotent', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1', 'r2'] })
    assignOwnedWorktree(store, 'r1')
    assignOwnedWorktree(store, 'r2')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const workspace = (await handlers.get('missions:ensureSession')!({}, { missionId: 'm1' })) as {
      id: string
      missionId: string
    }

    expect(workspace).toEqual({ id: 'fw-1', missionId: 'm1' })
    expect(missionRootMocks.resolveMissionRootPath).toHaveBeenCalledWith(
      missionsBaseDir,
      'Referral',
      'm1'
    )
    expect(store.setMissionRootPath).toHaveBeenCalledWith('m1', referralRootPath, missionsBaseDir)
    expect(missionRootMocks.ensureMissionRoot).toHaveBeenCalledWith({
      baseDir: missionsBaseDir,
      rootPath: referralRootPath,
      missionId: 'm1',
      links: [
        { name: 'repo-one', targetPath: wtR1Path },
        { name: 'repo-two', targetPath: wtR2Path }
      ]
    })

    await handlers.get('missions:ensureSession')!({}, { missionId: 'm1' })
    expect(store.setMissionRootPath).toHaveBeenCalledTimes(1)
    expect(store.ensureMissionSessionWorkspace).toHaveBeenCalledTimes(2)
  })

  it('tears down the session before deleting the record and owned root', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const owned = assignOwnedWorktree(store, 'r1')
    store.setMissionRootPath('m1', referralRootPath)
    store.ensureMissionSessionWorkspace('m1')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean }

    expect(result.deleted).toBe(true)
    expect(runtime.teardownWorkspaceProcesses).toHaveBeenCalledWith('folder:fw-1')
    expect(runtime.teardownWorkspaceProcesses.mock.invocationCallOrder[0]).toBeLessThan(
      store.deleteMission.mock.invocationCallOrder[0]
    )
    expect(
      runtime.findManagedWorktreesForMissionOwnership.mock.invocationCallOrder[0]
    ).toBeLessThan(store.flushOrThrow.mock.invocationCallOrder[0])
    expect(store.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      missionRootMocks.removeMissionRoot.mock.invocationCallOrder[0]
    )
    expect(missionRootMocks.removeMissionRoot.mock.invocationCallOrder[0]).toBeLessThan(
      store.deleteMission.mock.invocationCallOrder[0]
    )
    expect(store.flushOrThrow).toHaveBeenCalledTimes(2)
    expect(store.deleteMission.mock.invocationCallOrder[0]).toBeLessThan(
      store.flushOrThrow.mock.invocationCallOrder[1]
    )
    expect(store.flushOrThrow.mock.invocationCallOrder[1]).toBeLessThan(
      ownershipMarkerMocks.removeMissionWorktreeOwnershipMarker.mock.invocationCallOrder[0]
    )
    expect(store.setWorktreeMeta).toHaveBeenLastCalledWith(owned.worktreeId, {
      missionId: undefined
    })
    expect(missionRootMocks.removeMissionRoot).toHaveBeenCalledWith({
      baseDir: missionsBaseDir,
      rootPath: referralRootPath,
      missionId: 'm1'
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('promotes markerless add-complete ownership before preserved-checkout deletion', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = makeFakeRuntime(store)
    const proof = ownershipProofForRepo('r1')
    runtime.findManagedWorktreesForMissionOwnership.mockImplementation(async () => {
      store.setWorktreeMeta(proof.worktreeId, {
        missionId: proof.missionId,
        instanceId: proof.worktreeInstanceId
      })
      return { status: 'found', candidates: [proof] }
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean }

    expect(result.deleted).toBe(true)
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r1',
      proof.worktreeId,
      proof.worktreeInstanceId
    )
    expect(
      runtime.findManagedWorktreesForMissionOwnership.mock.invocationCallOrder[0]
    ).toBeLessThan(store.setMissionMemberWorktree.mock.invocationCallOrder[0])
    expect(store.setMissionMemberWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      store.flushOrThrow.mock.invocationCallOrder[0]
    )
    expect(store.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      missionRootMocks.removeMissionRoot.mock.invocationCallOrder[0]
    )
    expect(missionRootMocks.removeMissionRoot.mock.invocationCallOrder[0]).toBeLessThan(
      store.deleteMission.mock.invocationCallOrder[0]
    )
    expect(store.deleteMission.mock.invocationCallOrder[0]).toBeLessThan(
      store.flushOrThrow.mock.invocationCallOrder[1]
    )
    expect(store.flushOrThrow.mock.invocationCallOrder[1]).toBeLessThan(
      ownershipMarkerMocks.removeMissionWorktreeOwnershipMarker.mock.invocationCallOrder[0]
    )
    expect(ownershipMarkerMocks.removeMissionWorktreeOwnershipMarker).toHaveBeenCalledWith({
      repoPath: path.join(path.sep, 'repos', 'r1'),
      worktreePath: worktreePathForRepo('r1'),
      proof
    })
  })

  it('restores Mission guards when durable preserved-checkout deletion fails', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const owned = assignOwnedWorktree(store, 'r1')
    store.setMissionRootPath('m1', referralRootPath)
    store.ensureMissionSessionWorkspace('m1')
    store.flushOrThrow
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('disk full')
      })
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean; error?: string }

    expect(result).toEqual({ deleted: false, memberResults: [], error: 'disk full' })
    expect(store.getMission('m1')?.members[0]).toMatchObject(owned)
    expect(store.getMissionSessionWorkspace('m1')).toEqual({ id: 'fw-1', missionId: 'm1' })
    expect(store.getWorktreeMeta(owned.worktreeId)).toMatchObject({
      missionId: 'm1',
      instanceId: owned.worktreeInstanceId
    })
    expect(ownershipMarkerMocks.removeMissionWorktreeOwnershipMarker).not.toHaveBeenCalled()
    expect(() => assertWorktreeIsNotMissionManaged(store as never, owned.worktreeId)).toThrow(
      'mission_member_managed_by_mission'
    )
    expect(() => assertRepoIsNotMissionManaged(store.getMissions(), 'r1')).toThrow(
      'mission_member_managed_by_mission'
    )
  })

  it('fails preserved-checkout deletion closed when pending ownership scan is unavailable', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = makeFakeRuntime(store)
    runtime.findManagedWorktreesForMissionOwnership.mockResolvedValue({ status: 'unavailable' })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean; error?: string }

    expect(result).toMatchObject({
      deleted: false,
      error: 'mission_member_worktree_liveness_unavailable'
    })
    expect(missionRootMocks.removeMissionRoot).not.toHaveBeenCalled()
    expect(store.deleteMission).not.toHaveBeenCalled()
    expect(store.getMission('m1')).not.toBeNull()
  })

  it('fails preserved-checkout deletion closed when ownership recovery is ambiguous', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = makeFakeRuntime(store)
    runtime.findManagedWorktreesForMissionOwnership.mockResolvedValue({
      status: 'found',
      candidates: [
        ownershipProofForRepo('r1'),
        {
          missionId: 'm1',
          repoId: 'r1',
          worktreeId: `r1::${path.join(path.sep, 'wt', 'r1-duplicate')}`,
          worktreeInstanceId: 'instance-r1-duplicate'
        }
      ]
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:delete')!(
      {},
      { missionId: 'm1', deleteWorktrees: false }
    )) as { deleted: boolean; error?: string }

    expect(result).toMatchObject({
      deleted: false,
      error: 'mission_member_owned_worktree_ambiguous'
    })
    expect(missionRootMocks.removeMissionRoot).not.toHaveBeenCalled()
    expect(store.deleteMission).not.toHaveBeenCalled()
  })

  it('addMembers only fans out new native-local repos and syncs the mission root', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    assignOwnedWorktree(store, 'r1')
    store.setMissionRootPath('m1', referralRootPath)
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:addMembers')!(
      {},
      { missionId: 'm1', repoIds: ['r1', 'r2'] }
    )) as { memberResults: unknown[] }

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'id:r2',
        branchNameOverride: 'mission/referral',
        requireExactBranchName: true,
        missionId: 'm1',
        skipInitialTerminal: true,
        setupDecision: 'skip'
      })
    )
    expect(result.memberResults).toEqual([
      {
        repoId: 'r2',
        worktreeId: worktreeIdForRepo('r2'),
        worktreeInstanceId: instanceIdForRepo('r2')
      }
    ])
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r2',
      worktreeIdForRepo('r2'),
      instanceIdForRepo('r2')
    )
    expect(missionRootMocks.ensureMissionRoot).toHaveBeenCalledWith({
      baseDir: missionsBaseDir,
      rootPath: referralRootPath,
      missionId: 'm1',
      links: [
        { name: 'repo-one', targetPath: wtR1Path },
        { name: 'repo-two', targetPath: wtR2Path }
      ]
    })
  })

  it('removeMember deletes only a verified owned worktree and drops the member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const owned = assignOwnedWorktree(store, 'r1')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: true }
    )) as { deleted: boolean; memberResults: { repoId: string; worktreeId: string | null }[] }

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${owned.worktreeId}`,
      false,
      false,
      ownershipProofForRepo('r1')
    )
    expect(store.removeMissionMember).toHaveBeenCalledWith('m1', 'r1')
    expect(result.deleted).toBe(false)
    expect(result.memberResults).toEqual([{ repoId: 'r1', worktreeId: null }])
  })

  it('returns runtime and preserved-branch warnings from member deletion', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    assignOwnedWorktree(store, 'r1')
    const runtime = makeFakeRuntime(store)
    runtime.removeManagedWorktree.mockResolvedValue({
      warning: 'Archive hook was skipped.',
      preservedBranch: { branchName: 'mission/referral' }
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: true }
    )) as { memberResults: { warning?: string }[] }

    expect(result.memberResults[0].warning).toBe(
      'Archive hook was skipped. Preserved local branch mission/referral.'
    )
  })

  it('fails closed when member and metadata ownership stamps do not match', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const worktreeId = worktreeIdForRepo('r1')
    store.setMissionMemberWorktree('m1', 'r1', worktreeId, 'member-instance')
    store.setWorktreeMeta(worktreeId, { instanceId: 'different-instance', missionId: 'm1' })
    const runtime = makeFakeRuntime(store)
    ownershipMarkerMocks.assertMissionWorktreeOwnershipMarker.mockImplementationOnce(() => {
      throw new Error('mission_member_worktree_ownership_unverified')
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: true }
    )) as { memberResults: { worktreeId: string | null; error?: string }[] }

    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(store.removeMissionMember).not.toHaveBeenCalled()
    expect(result.memberResults).toEqual([
      {
        repoId: 'r1',
        worktreeId,
        error: 'mission_member_worktree_ownership_unverified'
      }
    ])
    expect(store.getMission('m1')?.members[0].lastError).toBe(
      'mission_member_worktree_ownership_unverified'
    )
  })

  it('removeMember keeps the worktree but detaches ownership when deleteWorktree is false', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.ensureMissionSessionWorkspace('m1')
    const owned = assignOwnedWorktree(store, 'r1')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await handlers.get('missions:removeMember')!(
      {},
      { missionId: 'm1', repoId: 'r1', deleteWorktree: false }
    )

    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).toHaveBeenLastCalledWith(owned.worktreeId, {
      missionId: undefined
    })
    expect(store.removeMissionMember).toHaveBeenCalledWith('m1', 'r1')
    expect(runtime.teardownWorkspaceProcesses).toHaveBeenCalledWith('folder:fw-1')
  })

  it('refuses to detach a physical child while the Mission root remains active', async () => {
    const store = makeFakeStore()
    const mission = store.createMission({ name: 'Referral', repoIds: ['r1'] })
    store.setMissionRootPath('m1', referralRootPath, missionsBaseDir)
    store.ensureMissionSessionWorkspace('m1')
    const worktreePath = path.join(referralRootPath, 'repo-one-r1')
    const worktreeId = `r1::${worktreePath}`
    store.setWorktreeMeta(worktreeId, { instanceId: 'instance-r1', missionId: 'm1' })
    store.setMissionMemberWorktree('m1', 'r1', worktreeId, 'instance-r1')
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:removeMember')!(
      {},
      { missionId: mission.id, repoId: 'r1', deleteWorktree: false }
    )) as { memberResults: { error?: string }[] }

    expect(result.memberResults[0].error).toBe('mission_member_workspace_delete_required')
    expect(store.removeMissionMember).not.toHaveBeenCalled()
    expect(store.getMission('m1')?.members).toHaveLength(1)
    expect(runtime.teardownWorkspaceProcesses).toHaveBeenCalledWith('folder:fw-1')
  })

  it('recreateMemberWorktree recreates and stamps the worktree for an existing member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:recreateMemberWorktree')!(
      {},
      { missionId: 'm1', repoId: 'r1' }
    )) as { repoId: string; worktreeId: string | null; worktreeInstanceId?: string | null }

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'id:r1',
        branchNameOverride: 'mission/referral',
        requireExactBranchName: true,
        missionId: 'm1'
      })
    )
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r1',
      worktreeIdForRepo('r1'),
      instanceIdForRepo('r1')
    )
    expect(result).toEqual({
      repoId: 'r1',
      worktreeId: worktreeIdForRepo('r1'),
      worktreeInstanceId: instanceIdForRepo('r1')
    })
  })

  it('recovers a marker-only crash window before creating a duplicate worktree', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = makeFakeRuntime(store)
    const proof = ownershipProofForRepo('r1')
    runtime.findManagedWorktreesForMissionOwnership.mockResolvedValue({
      status: 'found',
      candidates: [proof]
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = await handlers.get('missions:recreateMemberWorktree')!(
      {},
      { missionId: 'm1', repoId: 'r1' }
    )

    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.findManagedWorktreesForMissionOwnership).toHaveBeenCalledWith(
      'm1',
      'r1',
      'mission/referral'
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(proof.worktreeId, {
      missionId: 'm1',
      instanceId: proof.worktreeInstanceId
    })
    expect(store.setMissionMemberWorktree).toHaveBeenCalledWith(
      'm1',
      'r1',
      proof.worktreeId,
      proof.worktreeInstanceId
    )
    expect(result).toEqual({
      repoId: 'r1',
      worktreeId: proof.worktreeId,
      worktreeInstanceId: proof.worktreeInstanceId
    })
  })

  it('lets the current marker replace stale persisted ownership at the same path', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    assignOwnedWorktree(store, 'r1')
    const runtime = makeFakeRuntime(store)
    const currentProof = {
      ...ownershipProofForRepo('r1'),
      worktreeInstanceId: 'instance-after-recreate'
    }
    runtime.findManagedWorktreesForMissionOwnership.mockResolvedValue({
      status: 'found',
      candidates: [currentProof]
    })
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = await handlers.get('missions:recreateMemberWorktree')!(
      {},
      { missionId: 'm1', repoId: 'r1' }
    )

    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.inspectManagedWorktreeForOwnership).not.toHaveBeenCalled()
    expect(store.getWorktreeMeta(currentProof.worktreeId)).toMatchObject({
      missionId: 'm1',
      instanceId: currentProof.worktreeInstanceId
    })
    expect(store.getMission('m1')?.members[0]).toMatchObject({
      worktreeId: currentProof.worktreeId,
      worktreeInstanceId: currentProof.worktreeInstanceId
    })
    expect(result).toMatchObject({
      worktreeId: currentProof.worktreeId,
      worktreeInstanceId: currentProof.worktreeInstanceId
    })
  })

  it('recreates after a generic removal leaves only a stale Mission member pointer', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const staleWorktreeId = worktreeIdForRepo('r1')
    store.setMissionMemberWorktree('m1', 'r1', staleWorktreeId, instanceIdForRepo('r1'))
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    const result = (await handlers.get('missions:recreateMemberWorktree')!(
      {},
      { missionId: 'm1', repoId: 'r1' }
    )) as { worktreeId: string | null; worktreeInstanceId?: string | null }

    expect(runtime.inspectManagedWorktreeForOwnership).toHaveBeenCalledWith(staleWorktreeId)
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(result).toEqual({
      repoId: 'r1',
      worktreeId: staleWorktreeId,
      worktreeInstanceId: instanceIdForRepo('r1')
    })
  })

  it('recreateMemberWorktree rejects an unknown member', async () => {
    const store = makeFakeStore()
    store.createMission({ name: 'Referral', repoIds: ['r1'] })
    const runtime = makeFakeRuntime(store)
    registerMissionHandlers(makeFakeWindow() as never, store as never, runtime as never)

    await expect(
      handlers.get('missions:recreateMemberWorktree')!({}, { missionId: 'm1', repoId: 'ghost' })
    ).rejects.toThrow('mission_member_not_found')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
