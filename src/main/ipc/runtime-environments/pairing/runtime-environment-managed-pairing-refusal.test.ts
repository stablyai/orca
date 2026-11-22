import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadManagedIdentityError } from '../../../managed-server/lifecycle/orcad-managed-tunnel-identity'

const mocks = vi.hoisted(() => ({ authenticationRejected: vi.fn(), revision: 1 }))

vi.mock('../../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: async () => ({
    id: 'env-1',
    pairingRevision: mocks.revision,
    endpoints: [
      {
        id: 'direct',
        endpoint: 'ws://127.0.0.1:8080/runtime',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    orcadDeployment: { sshTargetId: 'ssh-1', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
  })
}))
vi.mock('../connections/runtime-environment-request-connections', () => ({
  withRuntimeEnvironmentStatusOwner: async (
    path: string,
    selector: string,
    consume: (...args: unknown[]) => unknown
  ) => {
    const { resolveEnvironment } =
      await import('../../../../shared/remote-runtime/host-store/runtime-environment-store')
    return consume(await resolveEnvironment(path, selector), {
      authenticationRejected: mocks.authenticationRejected
    })
  }
}))
vi.mock('../../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  managedOrcadPairingFailureStands: vi.fn(),
  recoverRefusedManagedOrcadPairing: vi.fn()
}))

const { handleManagedSharedControlRefusal } =
  await import('./runtime-environment-managed-pairing-refusal')

describe('handleManagedSharedControlRefusal', () => {
  beforeEach(() => {
    mocks.authenticationRejected.mockReset()
    mocks.revision = 1
  })

  it('stops retrying a pairing whose host now serves another server key (#37766)', async () => {
    const refusal = OrcadManagedIdentityError.replacedServer(
      { id: 'env-1', name: 'dev box' },
      'a different key'
    )
    await expect(
      handleManagedSharedControlRefusal(
        '/profile',
        'env-1',
        () => Promise.reject(refusal),
        async () => true
      )
    ).resolves.toBe('stop')
    expect(mocks.authenticationRejected).toHaveBeenCalled()
  })

  it('does not publish an old refusal onto a replacement pairing', async () => {
    const refusal = OrcadManagedIdentityError.replacedServer(
      { id: 'env-1', name: 'dev box' },
      'different key'
    )
    await expect(
      handleManagedSharedControlRefusal(
        '/profile',
        'env-1',
        async () => {
          throw refusal
        },
        async () => {
          mocks.revision = 2
          return true
        }
      )
    ).resolves.toBe('stop')
    expect(mocks.authenticationRejected).not.toHaveBeenCalled()
  })
})
