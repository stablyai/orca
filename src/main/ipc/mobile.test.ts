import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const { defaultRouteInterfaceNamesMock, handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  defaultRouteInterfaceNamesMock: vi.fn(),
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

// Mock interface enumeration only; integration fixtures still need real os.tmpdir.
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/rpc/server/pairing/network/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: defaultRouteInterfaceNamesMock
}))
import { registerMobileHandlers } from './mobile'

describe('registerMobileHandlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    networkInterfacesMock.mockReset()
    networkInterfacesMock.mockReturnValue({})
    defaultRouteInterfaceNamesMock.mockReset().mockResolvedValue(new Set())
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  // All accepted loopback spellings must honor an explicit this-computer reach.

  // Custom loopback frontends can tunnel to this host's LAN address; do not infer local-only intent from their shape.

  it('mints desktop pairing offers with the QR and link TTLs and returns their expiry', async () => {
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#mobile',
      endpoint: 'ws://192.168.1.24:6768',
      deviceId: 'mobile-1',
      connectionMode: 'automatic',
      offerExpiresAt: 1_000
    })
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://192.168.1.24:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://192.168.1.24:6768',
      deviceId: 'runtime-1',
      offerExpiresAt: 2_000
    })
    registerMobileHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call the three stubbed server members.
      {
        createMobilePairingOffer,
        createPairingOffer,
        ensureNetworkExposure: vi.fn().mockResolvedValue(undefined)
      } as never
    )

    await expect(
      handlers.get('mobile:getPairingQR')?.(null, { address: '192.168.1.24' })
    ).resolves.toMatchObject({ available: true, expiresAt: 1_000 })
    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ offerTtlMs: 10 * 60_000 })
    )
    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, { address: '192.168.1.24' })
    ).resolves.toMatchObject({ available: true, expiresAt: 2_000 })
    expect(createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ offerTtlMs: 60 * 60_000 })
    )
  })

  it('rejects firewall mutation from a non-window renderer', async () => {
    const runPowerShell = vi.fn()
    const rpcServer = { getWebSocketEndpoint: () => 'ws://0.0.0.0:6768' }
    registerMobileHandlers(rpcServer as never, {
      firewallEnvironment: {
        platform: 'win32',
        isPackaged: true,
        executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
        runPowerShell
      }
    })

    expect(
      handlers.get('mobile:repairWindowsFirewall')?.({
        sender: { isDestroyed: () => false, getType: () => 'webview' }
      })
    ).toEqual({ ok: false, reason: 'unsupported' })
    expect(runPowerShell).not.toHaveBeenCalled()
  })
})
