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

  it('re-reads system network interfaces on each request', () => {
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
        { name: 'en0', address: '192.168.1.24' },
        { name: 'tailscale0', address: '100.64.1.20' }
      ]
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
})
