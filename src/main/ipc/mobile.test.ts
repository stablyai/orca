import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
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

vi.mock('../runtime/windows-default-route-interfaces', () => ({
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
