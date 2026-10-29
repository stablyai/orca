import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  retire: vi.fn(),
  remove: vi.fn(),
  removeManaged: vi.fn(),
  closeTunnel: vi.fn(async () => {})
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.list,
  removeEnvironment: mocks.remove
}))
vi.mock('../../shared/runtime-environment-managed-orcad-store', () => ({
  removeManagedOrcadEnvironment: mocks.removeManaged
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: mocks.closeTunnel
}))

import { releaseEphemeralVmRuntimeEnvironments } from './runtime-environment-release'

describe('releaseEphemeralVmRuntimeEnvironments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("closes a destroyed VM's managed server tunnel and forgets the server", async () => {
    mocks.list.mockReturnValue([
      { id: 'env-vm', orcadDeployment: { sshTargetId: 'runtime-ssh-vm' } },
      { id: 'env-other', orcadDeployment: { sshTargetId: 'ssh-builder' } }
    ])
    await releaseEphemeralVmRuntimeEnvironments(
      '/user-data',
      { runtimeEnvironmentId: 'env-vm', sshTargetId: 'runtime-ssh-vm' },
      mocks.retire
    )
    expect(mocks.closeTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.closeTunnel).toHaveBeenCalledWith('env-vm')
    expect(mocks.removeManaged).toHaveBeenCalledTimes(1)
    expect(mocks.removeManaged).toHaveBeenCalledWith('/user-data', 'env-vm')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.retire).toHaveBeenCalledWith('env-vm')
    expect(mocks.removeManaged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.retire.mock.invocationCallOrder[0]
    )
  })

  it('finds the server of a relay-era VM that converted without recording it', async () => {
    mocks.list.mockReturnValue([
      { id: 'env-converted', orcadDeployment: { sshTargetId: 'runtime-ssh-vm' } }
    ])
    await releaseEphemeralVmRuntimeEnvironments(
      '/user-data',
      { sshTargetId: 'runtime-ssh-vm' },
      mocks.retire
    )
    expect(mocks.removeManaged).toHaveBeenCalledWith('/user-data', 'env-converted')
  })

  it('removes a paired recipe server the ordinary way', async () => {
    mocks.list.mockReturnValue([{ id: 'env-paired' }])
    await releaseEphemeralVmRuntimeEnvironments(
      '/user-data',
      { runtimeEnvironmentId: 'env-paired' },
      mocks.retire
    )
    expect(mocks.remove).toHaveBeenCalledWith('/user-data', 'env-paired')
    expect(mocks.retire).toHaveBeenCalledWith('env-paired')
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.retire.mock.invocationCallOrder[0]
    )
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('ignores a server that is already gone', async () => {
    mocks.list.mockReturnValue([])
    await releaseEphemeralVmRuntimeEnvironments(
      '/user-data',
      { runtimeEnvironmentId: 'env-gone' },
      mocks.retire
    )
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.removeManaged).not.toHaveBeenCalled()
    expect(mocks.retire).not.toHaveBeenCalled()
  })
})
