// #36363: the health probe of a sleeping VM's server would be the dial that wakes it.
import { describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'

const mocks = vi.hoisted(() => ({
  asleep: true,
  send: vi.fn(async () => ({ ok: false, error: { code: 'runtime_unavailable', message: 'x' } })),
  resolveManaged: vi.fn()
}))

vi.mock('../../runtime/construction/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({})
}))
vi.mock('../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: mocks.send
}))
vi.mock(
  '../../../shared/remote-runtime/host-catalog/runtime-environments',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getPreferredPairedRuntimeConnection: () => ({ endpoint: 'ws://vm', credential: {} })
  })
)
vi.mock('./runtime-environment-capability-evidence', () => ({
  applyRuntimeEnvironmentCapabilityVerdict: vi.fn(),
  getAcceptedRuntimeEnvironmentCapabilityOutcome: () => null,
  getRuntimeEnvironmentCapabilityIncarnation: () => 1,
  captureRuntimeEnvironmentCapabilityEvidence: () => ({})
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: mocks.resolveManaged
}))
vi.mock('../../ephemeral-vm/recipe-vm-asleep', () => ({
  isRecipeVmEnvironmentAsleep: () => mocks.asleep
}))

import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
import { RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE } from '../../../shared/remote-runtime/recipe-vm-wake'

function owner(connectionDependency?: 'ssh-tunnel') {
  const transport = { isReady: () => false, request: vi.fn(), establish: vi.fn(), pause: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the status owner reads.
  const environment = {
    id: 'env-vm',
    pairingRevision: 1,
    createdAt: 0,
    connectionDependency
  } as unknown as KnownRuntimeEnvironment
  return createRuntimeEnvironmentStatusOwner('/data', environment, transport)
}

describe('status probe of a sleeping VM server', () => {
  it('answers asleep without dialing, for paired and tunnelled servers', async () => {
    for (const dependency of [undefined, 'ssh-tunnel' as const]) {
      const response = await owner(dependency).refresh({ timeoutMs: 1_000 })
      expect(response).toMatchObject({
        ok: false,
        error: { code: RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE }
      })
    }
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.resolveManaged).not.toHaveBeenCalled()
  })
})
