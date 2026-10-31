import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: () => ({
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
  })
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: vi.fn().mockResolvedValue(new Set())
}))

import { registerMobileHandlers } from './mobile'

describe('Relay pairing without a local path', () => {
  it('mints a Relay code with no direct address, while LAN-only pairing keeps one', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#relay',
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'mobile-relay-only',
      connectionMode: 'automatic'
    })
    registerMobileHandlers({
      getNetworkExposureBindHost: () => '0.0.0.0',
      createMobilePairingOffer
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every server member getPairingQR calls.
    } as never)
    const getPairingQR = handlers.get('mobile:getPairingQR')

    await expect(
      getPairingQR?.(null, { address: '192.168.1.24', localPath: false })
    ).resolves.toMatchObject({ available: true, endpoint: null })
    expect(createMobilePairingOffer).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: null })
    )

    await getPairingQR?.(null, { connectionMode: 'local-only', localPath: false })
    expect(createMobilePairingOffer).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: '192.168.1.24', connectionMode: 'local-only' })
    )
  })
})
