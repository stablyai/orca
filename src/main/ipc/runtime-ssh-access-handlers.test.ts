import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), link: vi.fn(), unlink: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/runtime-ssh-access', () => ({
  linkRuntimeSshAccess: mocks.link,
  unlinkRuntimeSshAccess: mocks.unlink
}))
import { registerRuntimeSshAccessHandlers } from './runtime-ssh-access-handlers'

describe('existing paired server SSH access IPC', () => {
  const invalidateTransport = vi.fn()
  const request = {
    selector: 'host',
    requestId: 'request-1',
    sshTargetId: 'ssh-host',
    remotePort: 6768
  }
  beforeEach(() => {
    vi.clearAllMocks()
    registerRuntimeSshAccessHandlers({
      getUserDataPath: () => '/test-profile',
      invalidateTransport
    })
  })
  function handler(channel: string) {
    const registered = mocks.handle.mock.calls.find(([name]) => name === channel)
    if (!registered) {
      throw new Error('Handler missing')
    }
    return registered[1] as (_event: null, input: unknown) => Promise<unknown>
  }

  it('registers access-only actions and forwards only validated arguments and main-owned invalidation', async () => {
    expect(mocks.handle.mock.calls.map(([name]) => name)).toEqual([
      'runtimeEnvironments:linkSshAccess',
      'runtimeEnvironments:unlinkSshAccess'
    ])
    const result = {
      id: 'host',
      endpoints: [{ id: 'ssh-endpoint', endpoint: 'ws://127.0.0.1:41000' }]
    }
    mocks.link.mockResolvedValue(result)
    expect(await handler('runtimeEnvironments:linkSshAccess')(null, request)).toBe(result)
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith('/test-profile', request, {
      invalidateTransport
    })
    await handler('runtimeEnvironments:unlinkSshAccess')(null, {
      selector: 'host',
      requestId: 'unlink-1'
    })
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(
      '/test-profile',
      { selector: 'host', requestId: 'unlink-1' },
      { invalidateTransport }
    )
  })

  it.each([
    { remotePort: 0 },
    { remotePort: 65536 },
    { requestId: '../request' },
    { verifiedRuntimeId: 'renderer-supplied' },
    { userDataPath: '/other-profile' },
    { owner: { type: 'orcad-runtime', environmentId: 'other' } }
  ])('refuses invalid or authority-bearing link arguments: %j', async (change) => {
    await expect(
      handler('runtimeEnvironments:linkSshAccess')(null, { ...request, ...change })
    ).rejects.toThrow()
    expect(mocks.link).not.toHaveBeenCalled()
  })

  it('refuses renderer-supplied unlink snapshots', async () => {
    await expect(
      handler('runtimeEnvironments:unlinkSshAccess')(null, {
        selector: 'host',
        requestId: 'unlink-1',
        expectedEnvironment: { id: 'other' }
      })
    ).rejects.toThrow()
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  it('propagates pending failures instead of reporting a successful link', async () => {
    const error = new Error('SSH endpoint identity was not verified')
    mocks.link.mockRejectedValue(error)
    await expect(handler('runtimeEnvironments:linkSshAccess')(null, request)).rejects.toBe(error)
  })
})
