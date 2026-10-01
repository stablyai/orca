import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const state: { target?: SshTarget } = {}
  return { handle: vi.fn(), remove: vi.fn(), state, addTarget: vi.fn(), updateTarget: vi.fn() }
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
vi.mock('./ssh-ipc-context', () => ({ getCurrentMainWindow: () => null }))

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
    mocks.state.target = { ...target, owner: createManagedOrcadSshOwner('environment-1') }
    registerSshTargetCrudHandlers()
  })

  it('refuses to edit or remove a target a managed server owns', async () => {
    expect(() =>
      handler('ssh:updateTarget')(null, { id: 'ssh-1', updates: { host: 'elsewhere' } })
    ).toThrow('cannot be edited')
    await expect(handler('ssh:removeTarget')(null, { id: 'ssh-1' })).rejects.toThrow(
      'cannot be removed'
    )
    expect(mocks.updateTarget).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('refuses a target with a pending provisioning request too', () => {
    mocks.state.target = {
      ...target,
      orcadProvisioning: { requestId: 'request-1', name: 'Managed' }
    }
    expect(() => handler('ssh:updateTarget')(null, { id: 'ssh-1', updates: {} })).toThrow(
      'cannot be edited'
    )
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
