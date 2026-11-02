import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: false, once: vi.fn() },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: vi.fn().mockResolvedValue(new Set())
}))

import { registerMobileHandlers } from './mobile'
import type { CloudflareTunnelManager } from '../runtime/tunnel/cloudflare-tunnel-manager'
import { idlePublicTunnelState, type PublicTunnelState } from '../../shared/public-tunnel-types'

type FakeTunnel = {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getState: () => PublicTunnelState
  dispose: ReturnType<typeof vi.fn>
}

function createFakeTunnel(): FakeTunnel {
  let state: PublicTunnelState = idlePublicTunnelState()
  return {
    start: vi.fn(async () => {
      state = {
        ...idlePublicTunnelState(),
        status: 'connected',
        publicUrl: 'https://orca-demo-tunnel.trycloudflare.com',
        startedAt: 1_730_100_000_000
      }
      return { ok: true, publicUrl: state.publicUrl }
    }),
    stop: vi.fn(async () => {
      state = idlePublicTunnelState()
      return state
    }),
    getState: () => state,
    dispose: vi.fn()
  }
}

function rendererEvent(): {
  sender: {
    id: number
    isDestroyed: () => boolean
    getType: () => string
    send: ReturnType<typeof vi.fn>
  }
} {
  return {
    sender: {
      id: 1,
      isDestroyed: () => false,
      getType: () => 'window',
      send: vi.fn()
    }
  }
}

describe('public Cloudflare tunnel IPC', () => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation(
      (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }
    )
  })

  type FakeServer = {
    getNetworkExposureBindHost: () => string
    getWebSocketEndpoint: () => string
    createPairingOffer: ReturnType<typeof vi.fn>
  }

  function register(
    tunnel: FakeTunnel,
    overrides: Partial<FakeServer> = {}
  ): FakeServer {
    const server: FakeServer = {
      getNetworkExposureBindHost: () => '127.0.0.1',
      getWebSocketEndpoint: () => 'ws://127.0.0.1:6768',
      createPairingOffer: vi.fn().mockReturnValue({
        available: true,
        pairingUrl: 'ORCA-PAIRING-OFFER',
        endpoint: 'wss://orca-demo-tunnel.trycloudflare.com',
        deviceId: 'device-1',
        webClientUrl: 'https://orca-demo-tunnel.trycloudflare.com/web-index.html#pairing=x'
      }),
      ...overrides
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every member these handlers call.
    registerMobileHandlers(server as never, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the manager surface used here.
      publicTunnelManager: tunnel as unknown as CloudflareTunnelManager,
      encodePairingQr: async () => ({
        ok: true,
        qrDataUrl: 'data:image/png;base64,qr',
        qrSize: 100
      })
    })
    return server
  }

  it('starts cloudflared, mints a runtime offer, and returns the mobile fragment URL', async () => {
    const tunnel = createFakeTunnel()
    const server = register(tunnel)
    const event = rendererEvent()

    const state = (await handlers.get('mobile:startPublicTunnel')?.(event, {
      rotate: true
    })) as PublicTunnelState

    expect(tunnel.start).toHaveBeenCalledWith({ localPort: 6768 })
    expect(server.createPairingOffer).toHaveBeenCalledWith({
      address: 'wss://orca-demo-tunnel.trycloudflare.com',
      name: expect.stringContaining('Mobile '),
      scope: 'runtime',
      rotate: true,
      reach: 'network'
    })
    expect(state).toMatchObject({
      status: 'connected',
      publicUrl: 'https://orca-demo-tunnel.trycloudflare.com',
      remoteUrl:
        'https://orca-demo-tunnel.trycloudflare.com/remote#pairing=ORCA-PAIRING-OFFER',
      pairingUrl: 'ORCA-PAIRING-OFFER',
      deviceId: 'device-1',
      qrDataUrl: 'data:image/png;base64,qr',
      qrSize: 100
    })
    expect(event.sender.send).toHaveBeenCalledWith(
      'mobile:publicTunnelStatusChanged',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('returns the active tunnel state on remount and clears it when stopped', async () => {
    const tunnel = createFakeTunnel()
    register(tunnel)
    const event = rendererEvent()
    await handlers.get('mobile:startPublicTunnel')?.(event, {})

    expect(handlers.get('mobile:getPublicTunnelStatus')?.(event)).toMatchObject({
      status: 'connected',
      remoteUrl: expect.stringContaining('/remote#pairing=')
    })

    await expect(handlers.get('mobile:stopPublicTunnel')?.(event)).resolves.toEqual({
      status: 'idle',
      publicUrl: null,
      remoteUrl: null,
      webClientUrl: null,
      pairingUrl: null,
      deviceId: null,
      qrDataUrl: null,
      qrSize: null,
      error: null,
      startedAt: null
    })
    expect(tunnel.stop).toHaveBeenCalled()
  })

  it('maps a missing cloudflared binary to installation guidance', async () => {
    const tunnel = createFakeTunnel()
    tunnel.start.mockResolvedValue({
      ok: false,
      reason: 'cloudflared_not_found',
      message: 'cloudflared was not found.'
    })
    register(tunnel)

    await expect(
      handlers.get('mobile:startPublicTunnel')?.(rendererEvent(), {})
    ).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'cloudflared_not_found',
        guidance: expect.stringContaining('Install cloudflared')
      }
    })
  })

  it('stops the tunnel when a pairing offer cannot be minted', async () => {
    const tunnel = createFakeTunnel()
    register(tunnel, {
      createPairingOffer: vi.fn().mockReturnValue({
        available: false,
        reason: 'device_registry_unavailable',
        guidance: 'The pairing registry is unavailable.'
      })
    })

    await expect(
      handlers.get('mobile:startPublicTunnel')?.(rendererEvent(), {})
    ).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'pairing_unavailable',
        message: 'The pairing registry is unavailable.'
      }
    })
    expect(tunnel.stop).toHaveBeenCalled()
  })

  it('refuses tunnel control from a non-window renderer', async () => {
    const tunnel = createFakeTunnel()
    register(tunnel)
    const event = { sender: { id: 2, isDestroyed: () => false, getType: () => 'webview' } }

    await expect(
      handlers.get('mobile:startPublicTunnel')?.(event, {})
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'unsupported' }
    })
    expect(tunnel.start).not.toHaveBeenCalled()
  })
})
