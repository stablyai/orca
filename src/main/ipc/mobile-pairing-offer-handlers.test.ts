import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

// Pins the desktop's Settings pairing handlers: every branch's reply and the runtime calls it makes.
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

import type { MobilePairingQrResult } from '../runtime/rpc/server/pairing/mobile-pairing-qr'
import {
  MOBILE_PAIRING_OFFER_TTL_MS,
  RUNTIME_PAIRING_OFFER_TTL_MS
} from '../runtime/rpc/server/pairing/pairing-offer-expiry'
import { registerMobileHandlers } from './mobile'

const LAN = {
  en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '255.255.255.0' }]
}

type Call = { method: string; args?: unknown }

function fakeServer(options: {
  mobileOffer?: Record<string, unknown>
  runtimeOffer?: Record<string, unknown>
  exposureFails?: boolean
}) {
  const calls: Call[] = []
  const server = {
    getNetworkExposureBindHost: () => '0.0.0.0',
    ensureNetworkExposure: async () => {
      calls.push({ method: 'ensureNetworkExposure' })
      if (options.exposureFails) {
        throw new Error('bind refused')
      }
    },
    createMobilePairingOffer: async (args: Record<string, unknown>) => {
      calls.push({ method: 'createMobilePairingOffer', args: { ...args, name: typeof args.name } })
      return options.mobileOffer
    },
    createPairingOffer: (args: Record<string, unknown>) => {
      calls.push({ method: 'createPairingOffer', args: { ...args, name: typeof args.name } })
      return options.runtimeOffer
    }
  }
  return { server, calls }
}

const MOBILE_OFFER = {
  available: true,
  pairingUrl: 'orca://pair#x',
  endpoint: 'ws://192.168.1.20:6768',
  deviceId: 'dev-1',
  connectionMode: 'local-only',
  webClientUrl: null,
  offerExpiresAt: 1_000
}
const RUNTIME_OFFER = {
  available: true,
  pairingUrl: 'orca://pair#r',
  webClientUrl: 'http://192.168.1.20:6768/#r',
  endpoint: 'ws://192.168.1.20:6768',
  deviceId: 'dev-2',
  offerExpiresAt: 2_000
}

describe('desktop pairing IPC handlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const encodePairingQr = async (): Promise<MobilePairingQrResult> => ({
    ok: true,
    qrDataUrl: 'data:qr',
    qrSize: 21
  })

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    networkInterfacesMock.mockReset().mockReturnValue(LAN)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  async function call(
    channel: string,
    server: ReturnType<typeof fakeServer>['server'],
    args?: unknown
  ) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test call only the four methods the fake implements.
    registerMobileHandlers(server as never, {
      encodePairingQr,
      getDefaultRouteInterfaceNames: async () => new Set(['en0'])
    })
    return handlers.get(channel)?.({}, args)
  }

  describe('mobile:getPairingQR', () => {
    it('mints at an explicit address', async () => {
      const { server, calls } = fakeServer({ mobileOffer: MOBILE_OFFER })
      expect(
        await call('mobile:getPairingQR', server, {
          address: '100.64.1.20',
          connectionMode: 'local-only',
          rotate: true
        })
      ).toEqual({
        available: true,
        qrDataUrl: 'data:qr',
        qrSize: 21,
        pairingUrl: 'orca://pair#x',
        endpoint: 'ws://192.168.1.20:6768',
        deviceId: 'dev-1',
        connectionMode: 'local-only',
        expiresAt: 1_000
      })
      expect(calls).toEqual([
        {
          method: 'createMobilePairingOffer',
          args: {
            address: '100.64.1.20',
            connectionMode: 'local-only',
            rotate: true,
            name: 'string',
            offerTtlMs: MOBILE_PAIRING_OFFER_TTL_MS
          }
        }
      ])
    })

    it('falls back to the default LAN address', async () => {
      const { server, calls } = fakeServer({ mobileOffer: MOBILE_OFFER })
      await call('mobile:getPairingQR', server, { connectionMode: 'automatic' })
      expect(calls[0]?.args).toMatchObject({ address: '192.168.1.20' })
    })

    it('refuses LAN-only pairing with no usable address and mints nothing', async () => {
      networkInterfacesMock.mockReturnValue({})
      const { server, calls } = fakeServer({ mobileOffer: MOBILE_OFFER })
      expect(await call('mobile:getPairingQR', server, { connectionMode: 'local-only' })).toEqual({
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance:
          'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
      })
      expect(calls).toEqual([])
    })

    it('still asks for a Relay offer with no address, and hides the unadvertised endpoint', async () => {
      networkInterfacesMock.mockReturnValue({})
      const { server, calls } = fakeServer({ mobileOffer: MOBILE_OFFER })
      expect(await call('mobile:getPairingQR', server, { connectionMode: 'automatic' })).toEqual(
        expect.objectContaining({ available: true, endpoint: null })
      )
      expect(calls[0]?.args).toMatchObject({ address: null, connectionMode: 'automatic' })
    })

    it('passes through an unavailable offer with its Relay failure', async () => {
      const relayFailure = { kind: 'install_missing' }
      const { server } = fakeServer({
        mobileOffer: { available: false, reason: 'relay_unavailable', guidance: 'g', relayFailure }
      })
      expect(await call('mobile:getPairingQR', server, { connectionMode: 'automatic' })).toEqual({
        available: false,
        reason: 'relay_unavailable',
        guidance: 'g',
        relayFailure
      })
    })
  })

  describe('mobile:getRuntimePairingUrl', () => {
    it('widens, then mints a network-reach runtime link', async () => {
      const { server, calls } = fakeServer({ runtimeOffer: RUNTIME_OFFER })
      expect(await call('mobile:getRuntimePairingUrl', server, { rotate: true })).toEqual({
        available: true,
        pairingUrl: 'orca://pair#r',
        webClientUrl: 'http://192.168.1.20:6768/#r',
        endpoint: 'ws://192.168.1.20:6768',
        deviceId: 'dev-2',
        expiresAt: 2_000
      })
      expect(calls).toEqual([
        { method: 'ensureNetworkExposure' },
        {
          method: 'createPairingOffer',
          args: {
            address: '192.168.1.20',
            rotate: true,
            name: 'string',
            scope: 'runtime',
            reach: 'network',
            offerTtlMs: RUNTIME_PAIRING_OFFER_TTL_MS
          }
        }
      ])
    })

    it('keeps this-computer reach on loopback without widening', async () => {
      const { server, calls } = fakeServer({ runtimeOffer: RUNTIME_OFFER })
      await call('mobile:getRuntimePairingUrl', server, {
        address: '127.0.0.1',
        reach: 'this-computer'
      })
      expect(calls).toEqual([
        {
          method: 'createPairingOffer',
          args: expect.objectContaining({ address: '127.0.0.1', reach: 'this-computer' })
        }
      ])
    })

    it('widens for this-computer intent at a non-loopback address', async () => {
      const { server, calls } = fakeServer({ runtimeOffer: RUNTIME_OFFER })
      await call('mobile:getRuntimePairingUrl', server, {
        address: '192.168.1.20',
        reach: 'this-computer'
      })
      expect(calls.map((entry) => entry.method)).toEqual([
        'ensureNetworkExposure',
        'createPairingOffer'
      ])
      expect(calls[1]?.args).toMatchObject({ reach: 'network' })
    })

    it('reports a failed widening with guidance and mints nothing', async () => {
      const { server, calls } = fakeServer({ runtimeOffer: RUNTIME_OFFER, exposureFails: true })
      expect(await call('mobile:getRuntimePairingUrl', server)).toEqual({
        available: false,
        reason: 'network_exposure_failed',
        guidance: expect.any(String)
      })
      expect(calls).toEqual([{ method: 'ensureNetworkExposure' }])
    })

    it('answers a bare unavailable with no address or no offer', async () => {
      networkInterfacesMock.mockReturnValue({})
      const none = fakeServer({ runtimeOffer: RUNTIME_OFFER })
      expect(await call('mobile:getRuntimePairingUrl', none.server)).toEqual({ available: false })
      expect(none.calls).toEqual([])

      networkInterfacesMock.mockReturnValue(LAN)
      const refused = fakeServer({
        runtimeOffer: { available: false, reason: 'device_registry_unavailable', guidance: 'g' }
      })
      expect(await call('mobile:getRuntimePairingUrl', refused.server)).toEqual({
        available: false
      })
    })
  })
})
