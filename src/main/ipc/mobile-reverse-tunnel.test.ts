import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, listTunnelsMock, startTunnelMock, stopTunnelMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    listTunnelsMock: vi.fn(),
    startTunnelMock: vi.fn(),
    stopTunnelMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../mobile-reverse-tunnel/mobile-reverse-tunnel-manager', () => ({
  MobileReverseTunnelManager: class MockMobileReverseTunnelManager {
    setMainWindowGetter = vi.fn()
    listTunnels = listTunnelsMock
    startTunnel = startTunnelMock
    stopTunnel = stopTunnelMock
  }
}))

vi.mock('../mobile-reverse-tunnel/system-ssh-reverse-tunnel-process', () => ({
  probeRemoteEndpoint: vi.fn().mockResolvedValue(undefined)
}))

import {
  registerMobileReverseTunnelHandlers,
  resetMobileReverseTunnelHandlersForTests
} from './mobile-reverse-tunnel'

describe('registerMobileReverseTunnelHandlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    listTunnelsMock.mockReset().mockReturnValue([])
    startTunnelMock.mockReset().mockResolvedValue({
      id: 'mobile-tunnel-1',
      targetId: 'ssh-1',
      targetLabel: 'Relay',
      publicHost: '203.0.113.10',
      remoteBindHost: '0.0.0.0',
      remotePort: 6768,
      localHost: '127.0.0.1',
      localPort: 6768,
      advertisedAddress: '203.0.113.10:6768',
      status: 'running',
      error: null,
      startedAt: 1,
      updatedAt: 1
    })
    stopTunnelMock.mockReset().mockResolvedValue(true)
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    resetMobileReverseTunnelHandlersForTests()
  })

  it('starts a tunnel with a saved SSH target', async () => {
    const target = {
      id: 'ssh-1',
      label: 'Relay',
      host: '203.0.113.10',
      port: 22,
      username: 'deploy'
    }
    const store = {
      getSshTargets: vi.fn().mockReturnValue([target]),
      getSshTarget: vi.fn().mockReturnValue(target)
    }

    registerMobileReverseTunnelHandlers(store as never, () => null)

    await expect(
      handlers.get('mobileTunnel:start')?.(null, {
        targetId: 'ssh-1',
        publicHost: '203.0.113.10',
        remotePort: 6768,
        localPort: 6768
      })
    ).resolves.toMatchObject({
      advertisedAddress: '203.0.113.10:6768',
      status: 'running'
    })

    expect(startTunnelMock).toHaveBeenCalledWith(
      {
        targetId: 'ssh-1',
        publicHost: '203.0.113.10',
        remotePort: 6768,
        localPort: 6768
      },
      target
    )
  })

  it('throws when the SSH target does not exist', async () => {
    const store = {
      getSshTargets: vi.fn().mockReturnValue([]),
      getSshTarget: vi.fn().mockReturnValue(undefined)
    }

    registerMobileReverseTunnelHandlers(store as never, () => null)

    await expect(
      handlers.get('mobileTunnel:start')?.(null, {
        targetId: 'missing',
        publicHost: '203.0.113.10',
        remotePort: 6768,
        localPort: 6768
      })
    ).rejects.toThrow('SSH target "missing" not found.')
  })
})
