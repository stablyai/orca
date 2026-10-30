import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadManagedPairingRepairFailedError } from '../../managed-server/lifecycle/orcad-managed-pairing-repair-failure'

const mocks = vi.hoisted(() => ({
  resolveEnvironment: vi.fn(),
  authenticationRejected: vi.fn()
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: mocks.resolveEnvironment
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  recoverRefusedManagedOrcadPairing: vi.fn(),
  managedOrcadPairingFailureStands: vi.fn()
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({
    authenticationRejected: mocks.authenticationRejected
  })
}))

import { handleManagedSharedControlRefusal } from './runtime-environment-managed-pairing-refusal'

const SSH_MANAGED = {
  id: 'env-1',
  orcadDeployment: { sshTargetId: 'box', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
}

describe('handleManagedSharedControlRefusal', () => {
  beforeEach(() => {
    mocks.resolveEnvironment.mockReset()
    mocks.authenticationRejected.mockReset()
  })

  it.each([
    ['a user-paired server', { id: 'env-1' }],
    ['a WSL server', { id: 'env-1', orcadDeployment: { kind: 'wsl', distro: 'Ubuntu' } }]
  ])('leaves %s to the usual reconnect', (_name, environment) => {
    mocks.resolveEnvironment.mockReturnValue(environment)
    const recover = vi.fn()
    expect(handleManagedSharedControlRefusal('/profile', 'env-1', recover)).toBeNull()
    expect(recover).not.toHaveBeenCalled()
  })

  it('stays closed once the re-pair replaced the socket', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    const recover = vi.fn().mockResolvedValue('repaired')
    await expect(handleManagedSharedControlRefusal('/profile', 'env-1', recover)).resolves.toBe(
      'stop'
    )
    expect(recover).toHaveBeenCalledWith('/profile', 'env-1')
  })

  it('retries with backoff when the server turned out to accept the pairing', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    const recover = vi.fn().mockResolvedValue('built')
    await expect(handleManagedSharedControlRefusal('/profile', 'env-1', recover)).resolves.toBe(
      'retry'
    )
  })

  it('stops with the reason on the server status when pairing again failed', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    const failure = new OrcadManagedPairingRepairFailedError(
      'the server refused the new pairing too'
    )
    const recover = vi.fn().mockRejectedValue(failure)
    await expect(
      handleManagedSharedControlRefusal('/profile', 'env-1', recover, () => true)
    ).resolves.toBe('stop')
    expect(mocks.authenticationRejected).toHaveBeenCalledWith(failure.message)
  })

  it('leaves a newer pairing stored meanwhile to its own owner', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recover = vi
      .fn()
      .mockRejectedValue(new OrcadManagedPairingRepairFailedError('the server refused it'))
    // The failure stands for the old pairing only; an update stored a newer one meanwhile.
    await expect(
      handleManagedSharedControlRefusal('/profile', 'env-1', recover, () => false)
    ).resolves.toBe('retry')
    warn.mockRestore()
    expect(mocks.authenticationRejected).not.toHaveBeenCalled()
  })

  it('settles quietly when the server was removed while it re-paired', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    mocks.authenticationRejected.mockImplementation(() => {
      throw new Error('Unknown runtime environment')
    })
    const recover = vi
      .fn()
      .mockRejectedValue(new OrcadManagedPairingRepairFailedError('the server refused it'))
    await expect(
      handleManagedSharedControlRefusal('/profile', 'env-1', recover, () => true)
    ).resolves.toBe('stop')
  })

  it('keeps retrying after lost contact, which is no verdict on the pairing', async () => {
    mocks.resolveEnvironment.mockReturnValue(SSH_MANAGED)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recover = vi.fn().mockRejectedValue(new Error('ssh: connection reset'))
    await expect(handleManagedSharedControlRefusal('/profile', 'env-1', recover)).resolves.toBe(
      'retry'
    )
    warn.mockRestore()
    expect(mocks.authenticationRejected).not.toHaveBeenCalled()
  })
})
