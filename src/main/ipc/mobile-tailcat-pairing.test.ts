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
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

type TailcatPairingRpcServer = Pick<
  OrcaRuntimeRpcServer,
  'createPairingOffer' | 'ensureNetworkExposure'
>

function registerTailcatPairingHandlers(rpcServer: TailcatPairingRpcServer): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These tests exercise only the two supplied RPC methods through the runtime-pairing handler.
  registerMobileHandlers(rpcServer as OrcaRuntimeRpcServer)
}

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
    const createPairingOffer = vi.fn<OrcaRuntimeRpcServer['createPairingOffer']>().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#tunnel',
      // Why: createPairingOffer itself withholds the web URL for tunnel links.
      webClientUrl: null,
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'runtime-2'
    })
    const ensureNetworkExposure = vi
      .fn<OrcaRuntimeRpcServer['ensureNetworkExposure']>()
      .mockResolvedValue(undefined)
    registerTailcatPairingHandlers({ createPairingOffer, ensureNetworkExposure })

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
    const createPairingOffer = vi.fn<OrcaRuntimeRpcServer['createPairingOffer']>()
    const ensureNetworkExposure = vi.fn<OrcaRuntimeRpcServer['ensureNetworkExposure']>()
    registerTailcatPairingHandlers({ createPairingOffer, ensureNetworkExposure })

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
