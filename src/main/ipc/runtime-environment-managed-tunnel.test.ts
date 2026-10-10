import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureTunnel: vi.fn(async () => {}),
  rebuildTunnel: vi.fn(async () => {}),
  verify: vi.fn(),
  restoreUpdate: vi.fn(() => null),
  redeploy: vi.fn(async () => true)
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userData: string, id: string) => ({
    id,
    orcadDeployment: { sshTargetId: 'ssh-1' }
  })
}))
vi.mock('../ssh/managed-server-update-deps', () => ({ managedServerUpdateDeps: () => ({}) }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  rebuildOrcadManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../ssh/orcad-managed-serving-verify', () => ({
  verifyOrcadManagedServing: mocks.verify
}))
vi.mock('../ssh/orcad-managed-update-on-restore', () => ({
  updateManagedOrcadOnRestore: mocks.restoreUpdate,
  redeployStoppedManagedOrcad: mocks.redeploy
}))
vi.mock('../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: vi.fn() }))
vi.mock('../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => null }))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: null, getCurrentMainWindow: () => null }))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastSshState: vi.fn() }))

import { MANAGED_ORCAD_NOT_ACTIVATED_DETAIL } from '../ssh/orcad-managed-serving'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'

describe('resolving a managed runtime for a call', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redeploys, before the call, a server another desktop stopped mid-session', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).toHaveBeenCalledWith('env-1', expect.any(Function))
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
    // The forward is rebuilt for the port the redeployed server bound, not reused.
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('leaves a serving server to the once-per-session update check', async () => {
    mocks.verify.mockResolvedValue({ state: 'serving' })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('env-1', expect.any(Function))
  })
})
