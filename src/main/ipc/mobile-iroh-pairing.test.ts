import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: {
    create: vi.fn().mockReturnValue({ modules: { size: 21 } }),
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: vi.fn().mockResolvedValue(new Set())
}))

import { registerMobileHandlers } from './mobile'

describe('registerMobileHandlers iroh pairing', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    // No interfaces: iroh dials by key, so the offer must not need an address.
    networkInterfacesMock.mockReset().mockReturnValue({})
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  it('allows Iroh pairing without a network interface', async () => {
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#iroh',
      endpoint: `iroh://${'a'.repeat(64)}`,
      deviceId: 'mobile-iroh',
      connectionMode: 'iroh'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)
    await handlers.get('mobile:getPairingQR')?.(null, { connectionMode: 'iroh' })

    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: null, connectionMode: 'iroh' })
    )
  })

  it('reports iroh endpoint bind status for the pairing path picker', () => {
    registerMobileHandlers({
      getIrohEndpointId: () => 'a'.repeat(64)
    } as never)

    expect(handlers.get('mobile:getIrohStatus')?.()).toEqual({
      bound: true,
      endpointId: 'a'.repeat(64)
    })
  })
})
