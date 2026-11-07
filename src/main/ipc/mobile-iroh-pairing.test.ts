import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
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

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue([])
}))

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

import { registerMobileHandlers } from './mobile'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { MOBILE_PAIRING_OFFER_TTL_MS } from '../runtime/rpc/server/pairing/pairing-offer-expiry'

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

  it.each([undefined, '100.64.1.20'])(
    'pairs Iroh without LAN setup (address: %s)',
    async (address) => {
      const createMobilePairingOffer = vi.fn().mockResolvedValue({
        available: true,
        pairingUrl: 'orca://pair#iroh',
        endpoint: `iroh://${'a'.repeat(64)}`,
        deviceId: 'mobile-iroh',
        connectionMode: 'iroh'
      })

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler reads only the pairing offer and network bind host.
      registerMobileHandlers({
        createMobilePairingOffer,
        getNetworkExposureBindHost: () => '0.0.0.0'
      } as never)
      const result = await handlers.get('mobile:getPairingQR')?.(null, {
        address,
        connectionMode: 'iroh'
      })

      expect(createMobilePairingOffer).toHaveBeenCalledWith(
        expect.objectContaining({ address: null, connectionMode: 'iroh' })
      )
      expect(networkInterfacesMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ available: true, endpoint: `iroh://${'a'.repeat(64)}` })
    }
  )

  it('returns the current Iroh QR expiry and renews expired offers without exposing WebSocket', async () => {
    const now = Date.UTC(2026, 10, 3)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-qr-expiry-'))
    const endpointId = 'a'.repeat(64)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The double supplies the endpoint operations consumed by IrohTransport.
        endpoint: {
          online: async () => {},
          acceptNext: async () => null,
          close: async () => {},
          id: () => ({ toString: () => endpointId })
        } as never,
        endpointId
      })
    })

    try {
      await server.start()
      registerMobileHandlers(server)
      const wsEndpoint = server.getWebSocketEndpoint()
      expect(new URL(wsEndpoint!).hostname).toBe('127.0.0.1')
      const args = { address: '100.64.1.20', connectionMode: 'iroh' }
      const result = await handlers.get('mobile:getPairingQR')?.(null, args)
      const registry = server.getDeviceRegistry()!
      const first = registry.listPendingDevices('mobile')[0]!
      expect(first.offerExpiresAt).toBe(now + MOBILE_PAIRING_OFFER_TTL_MS)
      expect(result).toMatchObject({
        available: true,
        deviceId: first.deviceId,
        endpoint: `iroh://${endpointId}`,
        connectionMode: 'iroh',
        expiresAt: first.offerExpiresAt
      })
      expect(registry.validateToken(first.token)?.deviceId).toBe(first.deviceId)
      expect(server.getWebSocketEndpoint()).toBe(wsEndpoint)

      vi.setSystemTime(now + 120_000)
      await expect(handlers.get('mobile:getPairingQR')?.(null, args)).resolves.toEqual(result)

      vi.setSystemTime(now + MOBILE_PAIRING_OFFER_TTL_MS)
      expect(registry.validateToken(first.token)).toBeNull()
      const renewed = await handlers.get('mobile:getPairingQR')?.(null, args)
      const next = registry.listPendingDevices('mobile')[0]!
      expect(next.deviceId).not.toBe(first.deviceId)
      expect(next.offerExpiresAt).toBe(Date.now() + MOBILE_PAIRING_OFFER_TTL_MS)
      expect(renewed).toMatchObject({
        available: true,
        deviceId: next.deviceId,
        endpoint: `iroh://${endpointId}`,
        expiresAt: next.offerExpiresAt
      })
      expect(registry.getDevice(first.deviceId)).toBeNull()
      expect(networkInterfacesMock).not.toHaveBeenCalled()
      expect(server.getWebSocketEndpoint()).toBe(wsEndpoint)
    } finally {
      try {
        await server.stop()
      } finally {
        vi.useRealTimers()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  })
})
