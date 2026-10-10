import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const state: { target?: SshTarget } = {}
  return {
    handle: vi.fn(),
    remove: vi.fn(),
    state,
    addTarget: vi.fn(),
    updateTarget: vi.fn(),
    closeTunnel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {})
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({
    getTarget: () => mocks.state.target,
    addTarget: mocks.addTarget,
    updateTarget: mocks.updateTarget,
    lastRepoReadoptions: []
  })
}))
vi.mock('./ssh-session-teardown', () => ({ removeRegisteredSshTarget: mocks.remove }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ closeOrcadManagedTunnel: mocks.closeTunnel }))
vi.mock('./ssh-ipc-context', () => ({
  getCurrentMainWindow: () => null,
  connectionManager: { disconnect: mocks.disconnect }
}))

const { registerSshTargetCrudHandlers } = await import('./ssh-target-crud-handlers')

function handler(channel: string): (_event: unknown, args: unknown) => unknown {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

const target: SshTarget = { id: 'ssh-1', label: 'host', host: 'host', port: 22, username: 'dev' }

describe('SSH target CRUD against managed orcad targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.target = { ...target, orcadFence: { environmentId: 'environment-1' } }
    registerSshTargetCrudHandlers()
  })

  it("edits a managed host's connection, keeping its fence and redialing tunnel and transport", async () => {
    mocks.updateTarget.mockReturnValue({ ...mocks.state.target, host: 'elsewhere' })
    handler('ssh:updateTarget')(null, {
      id: 'ssh-1',
      updates: { host: 'elsewhere', orcadFence: undefined, generation: 9 }
    })
    expect(mocks.updateTarget).toHaveBeenCalledWith('ssh-1', { host: 'elsewhere' })
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('ssh-1'))
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
  })

  it('leaves the relay session of a host an older build changed alone when its connection is edited', async () => {
    mocks.state.target = {
      ...target,
      orcadFence: { environmentId: 'environment-1', sourceChangedAt: '2026-10-01T00:00:00.000Z' }
    }
    mocks.updateTarget.mockReturnValue({ ...mocks.state.target, port: 2222 })
    handler('ssh:updateTarget')(null, { id: 'ssh-1', updates: { port: 2222 } })
    await vi.waitFor(() => expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1'))
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('keeps the SSH transport when only a label changes', async () => {
    mocks.updateTarget.mockReturnValue({ ...mocks.state.target, label: 'renamed' })
    handler('ssh:updateTarget')(null, { id: 'ssh-1', updates: { label: 'renamed' } })
    await vi.waitFor(() => expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1'))
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('refuses to remove a managed host, pointing at Stop instead', async () => {
    await expect(handler('ssh:removeTarget')(null, { id: 'ssh-1' })).rejects.toThrow(
      'Settings › Managed servers'
    )
    mocks.state.target = {
      ...target,
      orcadProvisioning: { requestId: 'request-1', name: 'Managed' }
    }
    await expect(handler('ssh:removeTarget')(null, { id: 'ssh-1' })).rejects.toThrow(
      'managed Orca server'
    )
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('never lets the renderer write a provisioning intent', () => {
    mocks.state.target = target
    handler('ssh:updateTarget')(null, {
      id: 'ssh-1',
      updates: { label: 'renamed', orcadProvisioning: { requestId: 'x', name: 'y' } }
    })
    handler('ssh:addTarget')(null, {
      target: { ...target, orcadProvisioning: { requestId: 'x', name: 'y' } }
    })
    expect(mocks.updateTarget).toHaveBeenCalledWith('ssh-1', { label: 'renamed' })
    expect(mocks.addTarget.mock.calls[0]?.[0]).not.toHaveProperty('orcadProvisioning')
  })
})
