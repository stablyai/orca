import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

import { registerMobileHandlers } from './mobile'

describe('registerMobileHandlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
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
})
