// #36923: a remote open can wake an SSH-connected recipe VM. If the user disconnects its host while
// the recipe resumes, the wake must not reconnect it: the VM is up, and the host stays held.
import { afterEach, describe, expect, it, vi } from 'vitest'

const gates = vi.hoisted((): { resuming: PromiseWithResolvers<void> | null; skipped: boolean } => ({
  resuming: null,
  skipped: false
}))
const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ targetId: 'runtime-ssh-vm-1', environmentId: 'env-vm' })),
  refresh: vi.fn(() => ({ id: 'runtime-ssh-vm-1' })),
  updateStatus: vi.fn((_userDataPath: string, _id: string, patch: Record<string, unknown>) => patch)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  updateEphemeralVmRuntimeStatus: mocks.updateStatus
}))
vi.mock('../../shared/ephemeral-vm-workspace-runtime', () => ({
  findWorkspaceEphemeralVmRuntime: () => ({ id: 'vm-1', status: 'suspended', repoId: 'repo-1' })
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env-vm', pairingRevision: 9, createdAt: 0 }),
  updateEnvironmentFromPairingCode: vi.fn()
}))
vi.mock('../../shared/ephemeral-vm-recipes', () => ({
  getEphemeralVmRecipeResultConnection: () => ({ type: 'ssh', target: { host: 'vm' } }),
  getEphemeralVmRecipeResultPairingCode: () => null
}))
vi.mock('../ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: () => ({ repoPath: '/repo', recipe: {} })
}))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn()
}))
vi.mock('./runtime-service', () => ({
  resumeEphemeralVmRuntime: async () => {
    await gates.resuming?.promise
    return {
      ok: true,
      skipped: gates.skipped,
      runtime: { id: 'vm-1', status: 'running', recipeResult: {} }
    }
  }
}))
vi.mock('./runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: mocks.connect,
  refreshRuntimeOwnedSshTarget: mocks.refresh
}))

import type { Store } from '../persistence/loading-store/store'
import { acceptEphemeralVmWorkspaceWake, resumeEphemeralVmWorkspace } from './workspace-resume'
import {
  recordSshUserDisconnected,
  resetSshUserDisconnectsForTests
} from '../ssh/connection/ssh-user-disconnect'
import { getRuntimeOwnedSshTargetId } from '../ssh/targets/ssh-target-runtime-ownership'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe context reader is mocked, so the resume never reads this store.
const STORE = {} as Store

describe("waking an SSH-connected recipe VM and its host's Disconnect", () => {
  afterEach(() => {
    mocks.connect.mockClear()
    gates.resuming = null
    gates.skipped = false
    resetSshUserDisconnectsForTests()
  })

  // The reconnect can move the tunnel and re-pair the server; the open that waited expects that.

  it('leaves a Disconnect made during the wake in place, with the VM up', async () => {
    gates.resuming = Promise.withResolvers<void>()
    const woke = resumeEphemeralVmWorkspace(
      STORE,
      'workspace-1',
      acceptEphemeralVmWorkspaceWake('workspace-1')
    )
    recordSshUserDisconnected(getRuntimeOwnedSshTargetId('vm-1'))
    gates.resuming.resolve()

    await woke
    expect(mocks.connect).not.toHaveBeenCalled()
    // The resume's SSH address is saved for the user's later Connect.
    expect(mocks.refresh).toHaveBeenCalledWith({
      runtimeId: 'vm-1',
      connection: { type: 'ssh', target: { host: 'vm' } }
    })
    expect(mocks.updateStatus).toHaveBeenLastCalledWith('/user-data', 'vm-1', {
      connectionMode: 'ssh',
      sshTargetId: 'runtime-ssh-vm-1'
    })
  })

  it('honours a Disconnect made while the accepted wake waited its turn', async () => {
    const request = acceptEphemeralVmWorkspaceWake('workspace-1')
    // A suspend still running holds the wake back; the user disconnects meanwhile.
    recordSshUserDisconnected(getRuntimeOwnedSshTargetId('vm-1'))
    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', request)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('keeps a host the user had already disconnected when the wake was accepted', async () => {
    recordSshUserDisconnected(getRuntimeOwnedSshTargetId('vm-1'))
    const request = acceptEphemeralVmWorkspaceWake('workspace-1')
    await resumeEphemeralVmWorkspace(STORE, 'workspace-1', request)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  // Suspend tore down the VM's SSH transport, so the wake reconnects it even when the recipe had
  // no resume step to run.
})
