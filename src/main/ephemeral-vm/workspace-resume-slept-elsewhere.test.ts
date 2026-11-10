// A cloud VM slept from the CLI, the phone or another window still reads as running here until
// Orca loses contact with it. A wake (an open or a predictive wake) must resume it now instead of
// returning the stale record, and only a resume that ran counts as a quiet wake that woke it.
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  record: {} as Record<string, unknown>,
  asleep: false
}))
const mocks = vi.hoisted(() => ({
  resume: vi.fn(async () => ({
    ok: true,
    skipped: false,
    runtime: { id: 'vm-1', status: 'running' }
  })),
  markSlept: vi.fn((_path: string, seen: Record<string, unknown>) => ({
    ...seen,
    status: 'suspended'
  })),
  updateStatus: vi.fn((_userDataPath: string, _id: string, patch: Record<string, unknown>) => patch)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  updateEphemeralVmRuntimeStatus: mocks.updateStatus
}))
vi.mock('../../shared/ephemeral-vm-workspace-runtime', () => ({
  findWorkspaceEphemeralVmRuntime: () => state.record
}))
vi.mock('../hosted-sandbox/hosted-remote-sleep', () => ({
  isCloudWorkspaceAsleepOnControlPlane: async () => state.asleep,
  markCloudRuntimeSleptElsewhere: mocks.markSlept
}))
vi.mock('../ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: () => ({ repoPath: '/repo', recipe: { resume: 'orca-cloud resume' } })
}))
vi.mock('./runtime-service', () => ({ resumeEphemeralVmRuntime: mocks.resume }))

import type { Store } from '../persistence/loading-store/store'
import { resumeEphemeralVmWorkspace } from './workspace-resume'
import { endQuietWake, markQuietWake, takeQuietWakeResumed } from './quiet-wakes'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe context reader is mocked, so the resume never reads this store.
const STORE = {} as Store
const REQUEST = { sshHeld: false, sshUserDisconnects: 0 }
const CLOUD_RUNNING = { id: 'vm-1', status: 'running', recipe: { provider: 'orca-cloud' } }

describe('waking a cloud VM another client put to sleep', () => {
  afterEach(() => {
    state.asleep = false
    mocks.resume.mockClear()
    mocks.markSlept.mockClear()
    endQuietWake('ws')
    takeQuietWakeResumed('ws')
  })

  it('marks the stale running record asleep and resumes the VM', async () => {
    state.record = { ...CLOUD_RUNNING }
    state.asleep = true
    markQuietWake('ws')
    await resumeEphemeralVmWorkspace(STORE, 'ws', REQUEST)
    expect(mocks.markSlept).toHaveBeenCalledWith('/user-data', state.record)
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    expect(takeQuietWakeResumed('ws')).toBe(true)
  })

  it('leaves a VM the control plane says is up alone, and a quiet wake of it woke nothing', async () => {
    state.record = { ...CLOUD_RUNNING }
    markQuietWake('ws')
    expect(await resumeEphemeralVmWorkspace(STORE, 'ws', REQUEST)).toBe(state.record)
    expect(mocks.markSlept).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(takeQuietWakeResumed('ws')).toBe(false)
  })

  it('never asks about a record that is not a running cloud VM', async () => {
    state.record = { ...CLOUD_RUNNING, recipe: { provider: 'other' } }
    state.asleep = true
    await resumeEphemeralVmWorkspace(STORE, 'ws', REQUEST)
    expect(mocks.markSlept).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
  })
})
