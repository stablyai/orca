import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  deploy: vi.fn(),
  status: vi.fn(),
  registerProvisioning: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/orcad-runtime-lifecycle', () => ({
  createManagedOrcadEnvironment: mocks.deploy,
  getManagedOrcadRuntimeStatus: mocks.status
}))
vi.mock('./orcad-ssh-provisioning-handlers', () => ({
  registerOrcadSshProvisioningHandlers: mocks.registerProvisioning
}))

const { registerOrcadRuntimeLifecycleHandlers } = await import('./orcad-runtime-lifecycle-handlers')

function handler(channel: string): (_event: unknown, args: unknown) => unknown {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('managed orcad lifecycle IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerOrcadRuntimeLifecycleHandlers({ getUserDataPath: () => '/profile' })
  })

  it('registers only deploy, status and provisioning; maintenance and stop are not exposed', () => {
    expect(mocks.handle.mock.calls.map(([channel]) => channel)).toEqual([
      'runtimeEnvironments:deployOrcad',
      'runtimeEnvironments:getOrcadStatus'
    ])
    expect(mocks.registerProvisioning).toHaveBeenCalledOnce()
  })

  it('trims deploy input and treats only a literal true as force', async () => {
    await handler('runtimeEnvironments:deployOrcad')(null, {
      name: ' Managed ',
      sshTargetId: ' ssh-1 ',
      force: 'yes'
    })
    expect(mocks.deploy).toHaveBeenCalledWith('/profile', {
      name: 'Managed',
      sshTargetId: 'ssh-1',
      force: false
    })
  })

  it('rejects missing selectors before touching SSH', async () => {
    await expect(handler('runtimeEnvironments:deployOrcad')(null, { name: 'x' })).rejects.toThrow(
      'SSH target is required'
    )
    expect(() => handler('runtimeEnvironments:getOrcadStatus')(null, undefined)).toThrow(
      'Server is required'
    )
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.status).not.toHaveBeenCalled()
  })
})
