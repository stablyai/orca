import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadManagedIdentityError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'

const mocks = vi.hoisted(() => ({ authenticationRejected: vi.fn() }))

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ({
    id: 'env-1',
    orcadDeployment: { sshTargetId: 'ssh-1', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
  })
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({
    authenticationRejected: mocks.authenticationRejected
  })
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  managedOrcadPairingFailureStands: vi.fn(),
  recoverRefusedManagedOrcadPairing: vi.fn()
}))

const { handleManagedSharedControlRefusal } =
  await import('./runtime-environment-managed-pairing-refusal')

describe('handleManagedSharedControlRefusal', () => {
  beforeEach(() => mocks.authenticationRejected.mockReset())

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
        () => true
      )
    ).resolves.toBe('stop')
    expect(mocks.authenticationRejected).toHaveBeenCalledWith(
      refusal.message,
      'orcad_server_replaced'
    )
  })

  it('keeps retrying when another process answered on the port', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      handleManagedSharedControlRefusal(
        '/profile',
        'env-1',
        () => Promise.reject(OrcadManagedIdentityError.foreignPort(6_768, '4001')),
        () => true
      )
    ).resolves.toBe('retry')
    expect(mocks.authenticationRejected).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
