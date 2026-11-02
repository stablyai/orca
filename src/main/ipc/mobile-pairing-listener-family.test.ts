import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
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

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: vi.fn().mockResolvedValue(new Set())
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMobileHandlers } from './mobile'
import { createMobileRpcSurfaceRuntime } from '../runtime/runtime-rpc-mobile-method-allowlist-fixtures'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

const GLOBAL_IPV6 = '2605:340:cd51:2a01:0:2b13:f279:c096'

// IPv4-only 0.0.0.0 binds cannot serve advertised IPv6 links (#31161).
describe('pairing addresses follow the runtime listener family', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    networkInterfacesMock.mockReset().mockReturnValue({})
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  const registerStub = (stub: ReturnType<typeof stubServer>): void => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every server member the listing and runtime-link handlers call.
    registerMobileHandlers(stub as never)
  }

  const stubServer = (bindHost: string) => ({
    getNetworkExposureBindHost: () => bindHost,
    createPairingOffer: vi.fn(),
    ensureNetworkExposure: vi.fn().mockResolvedValue(undefined)
  })

  it('omits IPv6 addresses while the listener only serves IPv4', async () => {
    networkInterfacesMock.mockReturnValue({
      en1: [
        { family: 'IPv6', internal: false, address: GLOBAL_IPV6 },
        { family: 'IPv4', internal: false, address: '192.168.1.24' }
      ]
    })

    registerStub(stubServer('0.0.0.0'))

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [{ name: 'en1', address: '192.168.1.24' }]
    })
  })

  it('keeps dual-stack IPv6 ranked after IPv4 and excludes link-local IPv6', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        { family: 'IPv4', internal: false, address: '192.168.1.24' },
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv6', internal: false, address: GLOBAL_IPV6 }
      ],
      lo0: [{ family: 'IPv6', internal: true, address: '::1' }]
    })

    registerStub(stubServer('::'))

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'en0', address: '192.168.1.24' },
        { name: 'en0', address: GLOBAL_IPV6 }
      ]
    })
  })

  it('mints no runtime link on an IPv6-only host while the listener only serves IPv4', async () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [{ family: 'IPv6', internal: false, address: GLOBAL_IPV6 }]
    })
    const server = stubServer('0.0.0.0')

    registerStub(server)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: []
    })
    await expect(handlers.get('mobile:getRuntimePairingUrl')?.(null, {})).resolves.toEqual({
      available: false
    })
    expect(server.createPairingOffer).not.toHaveBeenCalled()
  })

  it('offers only addresses the real widened listener answers', async () => {
    networkInterfacesMock.mockReturnValue({
      en1: [
        { family: 'IPv4', internal: false, address: '192.168.1.24' },
        { family: 'IPv6', internal: false, address: GLOBAL_IPV6 }
      ]
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: createMobileRpcSurfaceRuntime().runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()

    try {
      registerMobileHandlers(server)
      await expect(handlers.get('mobile:getRuntimePairingUrl')?.(null, {})).resolves.toMatchObject({
        available: true,
        endpoint: expect.stringMatching(/^ws:\/\/192\.168\.1\.24:/)
      })
      expect(server.getWebSocketEndpoint()).toMatch(/^ws:\/\/0\.0\.0\.0:/)
      await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
        interfaces: [{ name: 'en1', address: '192.168.1.24' }]
      })
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
