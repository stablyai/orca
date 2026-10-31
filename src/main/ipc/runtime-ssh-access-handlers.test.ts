import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  restoreForwards: vi.fn(),
  connectHost: vi.fn(async () => ({})),
  endSshSession: vi.fn(async () => {})
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/runtime-ssh-access', () => ({
  linkRuntimeSshAccess: mocks.link,
  unlinkRuntimeSshAccess: mocks.unlink
}))
vi.mock('./ssh/ssh-managed-port-forward-restore', () => ({
  restoreManagedHostPortForwards: mocks.restoreForwards
}))
vi.mock('./ssh/ssh-session-teardown', () => ({
  disconnectRegisteredSshTargetInLifecycle: mocks.endSshSession
}))
vi.mock('../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: mocks.connectHost
}))
import { registerRuntimeSshAccessHandlers } from './runtime-ssh-access-handlers'
import { EventEmitter } from 'node:events'

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
  const sender = new EventEmitter()
  const event = { sender }
  function handler(
    channel: string
  ): (_event: typeof event | null, input: unknown) => Promise<unknown> {
    const registered = mocks.handle.mock.calls.find(([name]) => name === channel)
    if (!registered) {
      throw new Error('Handler missing')
    }
    return registered[1]
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
    expect(await handler('runtimeEnvironments:linkSshAccess')(event, request)).toBe(result)
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith('/test-profile', request, {
      signal: expect.any(AbortSignal),
      invalidateTransport
    })
    expect(sender.listenerCount('destroyed')).toBe(0)
    await handler('runtimeEnvironments:unlinkSshAccess')(null, {
      selector: 'host',
      requestId: 'unlink-1'
    })
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(
      '/test-profile',
      { selector: 'host', requestId: 'unlink-1' },
      // Unlink already holds the host's lifecycle queue, so it ends the session without queueing.
      { invalidateTransport, endSshSession: mocks.endSshSession }
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

  it('cancels a pending link when its window closes', async () => {
    let signal: AbortSignal | undefined
    mocks.link.mockImplementation(async (_path, _args, options: { signal: AbortSignal }) => {
      signal = options.signal
      sender.emit('destroyed')
      return null
    })
    await handler('runtimeEnvironments:linkSshAccess')(event, request)
    expect(signal?.aborted).toBe(true)
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
    await expect(handler('runtimeEnvironments:linkSshAccess')(event, request)).rejects.toBe(error)
    expect(mocks.restoreForwards).not.toHaveBeenCalled()
  })

  it("restores the linked host's saved forwards once the link is saved", async () => {
    mocks.link.mockResolvedValue({ id: 'host' })
    await handler('runtimeEnvironments:linkSshAccess')(event, request)
    expect(mocks.restoreForwards).toHaveBeenCalledExactlyOnceWith('ssh-host', { tunnelUp: true })
    expect(mocks.connectHost).not.toHaveBeenCalled()
  })

  it('connects a ports-only host, which no server connection brings up, once it is linked', async () => {
    mocks.link.mockResolvedValue({ id: 'host' })
    await handler('runtimeEnvironments:linkSshAccess')(event, { ...request, portsOnly: true })
    expect(mocks.connectHost).toHaveBeenCalledExactlyOnceWith('ssh-host')
    expect(mocks.restoreForwards).not.toHaveBeenCalled()
  })
})
