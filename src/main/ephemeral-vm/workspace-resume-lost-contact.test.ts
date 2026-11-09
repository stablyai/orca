// #34089: a VM its provider stopped or reclaimed stays recorded as running. Opening its workspace
// must run the recipe's resume instead of returning the dead record unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionStatus } from '../../shared/ssh-types'

type MockState = {
  record: Record<string, unknown>
  sshStatus: SshConnectionStatus | undefined
}

const UP_RECORD = {
  id: 'vm-1',
  status: 'running',
  connectionMode: 'ssh',
  sshTargetId: 'runtime-ssh-vm-1',
  runtimeEnvironmentId: 'env-vm'
}

const state = vi.hoisted((): MockState => ({
  record: {
    id: 'vm-1',
    status: 'running',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-vm-1',
    runtimeEnvironmentId: 'env-vm'
  },
  sshStatus: undefined
}))
const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  connect: vi.fn(async () => ({ targetId: 'runtime-ssh-vm-1', environmentId: 'env-vm' })),
  reconnectControl: vi.fn(),
  refreshStatus: vi.fn(async () => ({})),
  updateStatus: vi.fn((_userDataPath: string, _id: string, patch: Record<string, unknown>) => patch)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  updateEphemeralVmRuntimeStatus: mocks.updateStatus
}))
vi.mock('../../shared/ephemeral-vm-workspace-runtime', () => ({
  findWorkspaceEphemeralVmRuntime: () => state.record
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env-vm', pairingRevision: 9, createdAt: 0 })
}))
vi.mock('../../shared/ephemeral-vm-recipes', () => ({
  getEphemeralVmRecipeResultConnection: () => ({ type: 'ssh', target: { host: 'vm' } }),
  getEphemeralVmRecipeResultPairingCode: () => null
}))
vi.mock('../ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: () => ({ repoPath: '/repo', recipe: { resume: './resume.sh' } })
}))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn()
}))
vi.mock('../ipc/runtime-environments/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({ refresh: mocks.refreshStatus }),
  reconnectRemoteRuntimeSharedControlConnection: mocks.reconnectControl
}))
vi.mock('../ssh/targets/ssh-target-registry', () => ({
  getRegisteredSshState: () => (state.sshStatus ? { status: state.sshStatus } : undefined)
}))
vi.mock('./runtime-service', () => ({ resumeEphemeralVmRuntime: mocks.resume }))
vi.mock('./runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: mocks.connect,
  refreshRuntimeOwnedSshTarget: vi.fn()
}))

import type { Store } from '../persistence/loading-store/store'
import { resumeEphemeralVmWorkspace } from './workspace-resume'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe context reader is mocked, so the resume never reads this store.
const STORE = {} as Store
const REQUEST = { sshHeld: false, sshUserDisconnects: 0 }

const RESUMED = {
  ok: true,
  skipped: false,
  runtime: { id: 'vm-1', status: 'running', recipeResult: {} }
}

describe('opening a workspace whose VM host Orca gave up reaching', () => {
  afterEach(() => {
    vi.useRealTimers()
    state.record = { ...UP_RECORD }
    state.sshStatus = undefined
    mocks.resume.mockReset()
    mocks.connect.mockClear()
    mocks.reconnectControl.mockClear()
    mocks.refreshStatus.mockClear()
    mocks.updateStatus.mockClear()
  })

  it('runs the recipe resume, reconnects the VM and reopens its server', async () => {
    vi.useFakeTimers()
    state.sshStatus = 'reconnection-failed'
    mocks.resume.mockResolvedValue(RESUMED)

    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)
    await vi.runAllTimersAsync()

    expect(mocks.resume).toHaveBeenCalledTimes(1)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.reconnectControl).toHaveBeenCalledWith('env-vm')
    expect(mocks.refreshStatus).toHaveBeenCalledWith({ reconnect: true })
  })

  it('leaves a VM alone while its host answers, is reconnecting, or was never dialed', async () => {
    for (const sshStatus of [undefined, 'connected', 'reconnecting', 'connecting'] as const) {
      state.sshStatus = sshStatus
      await expect(resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)).resolves.toBe(
        state.record
      )
    }
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('leaves a host the user disconnected, and a paired VM, to their own reconnects', async () => {
    state.sshStatus = 'reconnection-failed'
    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', { ...REQUEST, sshHeld: true })
    state.record = { ...UP_RECORD, connectionMode: 'paired', sshTargetId: undefined }
    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it('keeps the record as it was when the recovery fails, so reconnects go on', async () => {
    state.sshStatus = 'reconnection-failed'
    mocks.resume.mockResolvedValue({
      ok: false,
      error: 'resume failed',
      runtime: { id: 'vm-1', status: 'resume_failed' }
    })

    await expect(resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)).rejects.toThrow(
      'resume failed'
    )
    expect(mocks.updateStatus).toHaveBeenLastCalledWith('/user-data', 'vm-1', {
      status: 'running'
    })
  })

  it('keeps a failed connect after recovery from parking the VM as asleep', async () => {
    state.sshStatus = 'reconnection-failed'
    state.record = { ...UP_RECORD, status: 'suspend_failed' }
    mocks.resume.mockResolvedValue(RESUMED)
    mocks.connect.mockRejectedValueOnce(new Error('ssh unreachable'))

    await expect(resumeEphemeralVmWorkspace(STORE, 'workspace-1', REQUEST)).rejects.toThrow(
      'ssh unreachable'
    )
    expect(mocks.updateStatus).toHaveBeenLastCalledWith('/user-data', 'vm-1', {
      status: 'suspend_failed'
    })
  })
})
