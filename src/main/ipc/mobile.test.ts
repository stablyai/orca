import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

vi.mock('os', () => ({
  networkInterfaces: networkInterfacesMock
}))

import { registerMobileHandlers } from './mobile'

describe('registerMobileHandlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    networkInterfacesMock.mockReset()
    networkInterfacesMock.mockReturnValue({})
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  it('re-reads system network interfaces on each request and prefers tailnet addresses', () => {
    networkInterfacesMock
      .mockReturnValueOnce({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      .mockReturnValueOnce({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }],
        tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.1.20' }]
      })

    registerMobileHandlers({} as never)

    expect(handlers.get('mobile:listNetworkInterfaces')?.()).toEqual({
      interfaces: [{ name: 'en0', address: '192.168.1.24' }]
    })
    expect(handlers.get('mobile:listNetworkInterfaces')?.()).toEqual({
      interfaces: [
        { name: 'tailscale0', address: '100.64.1.20' },
        { name: 'en0', address: '192.168.1.24' }
      ]
    })
  })

  it('generates mobile pairing urls with the tailnet address by default', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.102.47.57' }]
    })
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#mobile',
      endpoint: 'ws://100.102.47.57:6768',
      deviceId: 'mobile-1'
    })
    const rpcServer = { createPairingOffer }

    registerMobileHandlers(rpcServer as never)

    await expect(handlers.get('mobile:getPairingQR')?.(null, {})).resolves.toMatchObject({
      available: true,
      pairingUrl: 'orca://pair#mobile',
      endpoint: 'ws://100.102.47.57:6768',
      deviceId: 'mobile-1'
    })

    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '100.102.47.57',
      rotate: undefined,
      name: expect.stringMatching(/^Mobile /),
      scope: 'mobile'
    })
  })

  it('lists only paired mobile-scoped devices', () => {
    const rpcServer = {
      getDeviceRegistry: () => ({
        listDevices: () => [
          {
            deviceId: 'mobile-1',
            name: 'Phone',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'runtime-1',
            name: 'CLI',
            scope: 'runtime',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'pending-mobile',
            name: 'Pending',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 0
          }
        ]
      })
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:listDevices')?.()).toEqual({
      devices: [
        {
          deviceId: 'mobile-1',
          name: 'Phone',
          pairedAt: 1,
          lastSeenAt: 2
        }
      ]
    })
  })

  it('generates runtime-scoped pairing urls for web and desktop clients', async () => {
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'runtime-1'
    })
    const rpcServer = { createPairingOffer }

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        rotate: true
      })
    ).resolves.toEqual({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'runtime-1'
    })

    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '100.64.1.20',
      rotate: true,
      name: expect.stringMatching(/^Runtime /),
      scope: 'runtime'
    })
  })

  it('lists runtime access grants including unused generated links', () => {
    const rpcServer = {
      getDeviceRegistry: () => ({
        listDevices: () => [
          {
            deviceId: 'mobile-1',
            name: 'Phone',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'runtime-1',
            name: 'Browser',
            scope: 'runtime',
            pairedAt: 3,
            lastSeenAt: 4
          },
          {
            deviceId: 'pending-runtime',
            name: 'Copied link',
            scope: 'runtime',
            pairedAt: 5,
            lastSeenAt: 0
          }
        ]
      })
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:listRuntimeAccessGrants')?.()).toEqual({
      grants: [
        {
          deviceId: 'pending-runtime',
          name: 'Copied link',
          createdAt: 5,
          lastSeenAt: null
        },
        {
          deviceId: 'runtime-1',
          name: 'Browser',
          createdAt: 3,
          lastSeenAt: 4
        }
      ]
    })
  })

  it('revokes runtime access through the runtime server', () => {
    const revokeRuntimeAccess = vi.fn().mockReturnValue(true)
    const rpcServer = {
      getDeviceRegistry: () => ({}),
      revokeRuntimeAccess
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:revokeRuntimeAccess')?.(null, { deviceId: 'runtime-1' })).toEqual({
      revoked: true
    })
    expect(revokeRuntimeAccess).toHaveBeenCalledWith('runtime-1')
  })
})
