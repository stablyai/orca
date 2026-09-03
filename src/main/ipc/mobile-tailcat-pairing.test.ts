import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, tunnelEnsureServer } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  tunnelEnsureServer: vi.fn(async () => 'tcTOKEN')
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('../tunnel/tailcat-tunnel-host', () => ({
  getTailcatTunnelService: () => ({ ensureServer: tunnelEnsureServer }),
  boundWebSocketPort: () => 6768
}))

vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/tmp/orca-mobile-tailcat-test'
}))

import { registerMobileHandlers } from './mobile'

describe('mobile:getRuntimePairingUrl with a Tailcat transport', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    tunnelEnsureServer.mockClear()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  it('keeps the offer on loopback whatever reach the renderer sent', async () => {
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#tunnel',
      // Why: createPairingOffer itself withholds the web URL for tunnel links.
      webClientUrl: null,
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'runtime-2'
    })
    const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
    registerMobileHandlers({ createPairingOffer, ensureNetworkExposure } as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        rotate: true,
        reach: 'network',
        transport: 'tailcat'
      })
    ).resolves.toEqual({
      available: true,
      pairingUrl: 'orca://pair#tunnel',
      webClientUrl: null,
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'runtime-2'
    })
    // Why: the tunnel proxies into loopback; main must never widen the listener for it.
    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(tunnelEnsureServer).toHaveBeenCalledWith(6768)
    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '127.0.0.1',
      rotate: true,
      name: expect.stringMatching(/^Runtime /),
      scope: 'runtime',
      reach: 'this-computer',
      tunnel: true
    })
  })

  it('reports the tunnel unavailable when tailcat cannot start', async () => {
    tunnelEnsureServer.mockRejectedValueOnce(new Error('Install the tailcat CLI.'))
    const createPairingOffer = vi.fn()
    registerMobileHandlers({ createPairingOffer, ensureNetworkExposure: vi.fn() } as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, { transport: 'tailcat' })
    ).resolves.toEqual({
      available: false,
      reason: 'tunnel_unavailable',
      guidance: 'Install the tailcat CLI.'
    })
    expect(createPairingOffer).not.toHaveBeenCalled()
  })
})
