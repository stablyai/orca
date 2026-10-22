import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { registerRuntimeEnvironmentEdgeAuthHandlers } from './runtime-environment-edge-auth-handlers'
const dependencies = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  resolve: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  status: vi.fn(),
  invalidate: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      dependencies.handlers.set(channel, fn)
  }
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: dependencies.resolve
}))
vi.mock('../../credentials/runtime-edge-auth-store', () => ({
  writeRuntimeEdgeAuth: dependencies.write,
  clearRuntimeEdgeAuth: dependencies.clear,
  getRuntimeEdgeAuthStatus: dependencies.status
}))
const environment = createEnvironmentFromPairingOffer({
  id: 'env-1',
  name: 'server',
  now: 1,
  offer: {
    v: 2,
    endpoint: 'wss://orca.example',
    publicKeyB64: 'synthetic-key',
    deviceToken: 'synthetic-device'
  }
})
beforeEach(() => {
  dependencies.handlers.clear()
  dependencies.resolve.mockReset().mockReturnValue(environment)
  dependencies.write.mockReset()
  dependencies.clear.mockReset()
  dependencies.invalidate.mockReset().mockResolvedValue(undefined)
  dependencies.status.mockReset().mockReturnValue({ configured: true, unreadable: false })
  registerRuntimeEnvironmentEdgeAuthHandlers({
    getUserDataPath: () => '/private/profile',
    invalidateTransport: dependencies.invalidate
  })
})
function invoke(channel: string, args: unknown) {
  return dependencies.handlers.get(`runtimeEnvironments:${channel}`)?.({}, args)
}
describe('local edge credential mutation ownership', () => {
  it('saves normalized headers and invalidates all existing transports, returning no secret values', async () => {
    const result = await invoke('saveEdgeAuth', {
      environmentId: 'env-1',
      expectedPairingRevision: 1,
      headers: [{ name: ' X-Token ', value: 'synthetic-secret' }]
    })
    expect(dependencies.write).toHaveBeenCalledWith('/private/profile', environment, {
      'X-Token': 'synthetic-secret'
    })
    expect(dependencies.invalidate).toHaveBeenCalledWith('env-1')
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it('refuses stale pairing revisions before touching storage', async () => {
    await expect(
      invoke('saveEdgeAuth', {
        environmentId: 'env-1',
        expectedPairingRevision: 0,
        headers: [{ name: 'X', value: 'secret' }]
      })
    ).rejects.toThrow('Server pairing changed')
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.invalidate).not.toHaveBeenCalled()
  })
  it('does not interpret blank rows as clear', async () => {
    await expect(
      invoke('saveEdgeAuth', { environmentId: 'env-1', expectedPairingRevision: 1, headers: [] })
    ).rejects.toThrow('Enter valid edge authentication headers')
    expect(dependencies.clear).not.toHaveBeenCalled()
  })
  it('clears explicitly and invalidates current sockets', async () => {
    await invoke('clearEdgeAuth', { environmentId: 'env-1', expectedPairingRevision: 1 })
    expect(dependencies.clear).toHaveBeenCalledWith('/private/profile', 'env-1')
    expect(dependencies.invalidate).toHaveBeenCalledWith('env-1')
  })
  it('returns only configured/unreadable status', () => {
    expect(invoke('getEdgeAuthStatus', { environmentId: 'env-1' })).toEqual({
      configured: true,
      unreadable: false
    })
    expect(dependencies.write).not.toHaveBeenCalled()
  })
  it('does not reset transports if protected persistence fails', async () => {
    dependencies.write.mockImplementation(() => {
      throw new Error('Could not save edge authentication')
    })
    await expect(
      invoke('saveEdgeAuth', {
        environmentId: 'env-1',
        expectedPairingRevision: 1,
        headers: [{ name: 'X', value: 'secret' }]
      })
    ).rejects.toThrow('Could not save edge authentication')
    expect(dependencies.invalidate).not.toHaveBeenCalled()
  })
})
