import { vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import type { WslOrcadConnection } from './wsl-orcad-connection'

export const KEY = Buffer.alloc(32, 3).toString('base64')
export const UBUNTU_ID = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'

export function pairing(port: number, deviceToken = 'token-1', publicKeyB64 = KEY): string {
  return encodePairingOffer({ v: 2, endpoint: `ws://127.0.0.1:${port}`, deviceToken, publicKeyB64 })
}

export function connection(distro: string, port = 42000, token = 'token-1'): WslOrcadConnection {
  return {
    distro,
    environmentId: `wsl:${distro.toLowerCase()}`,
    localPort: port,
    remotePort: 6768,
    fullVersion: '1.0.0+abc',
    pid: 10,
    pairingOffer: pairing(port, token),
    deferredUpdate: null,
    close: async () => {}
  }
}

export function makeConnector(distros: WslHostDistroCandidate[]) {
  const active = new Map<string, WslOrcadConnection>()
  // What WSL's running list says about the distro when its server isn't answering.
  const distro: { state: 'running' | 'stopped' | 'unavailable' } = { state: 'running' }
  const connector = {
    listDistros: vi.fn(async () => distros),
    readOrcadPublicKey: vi.fn(async (_distro: string): Promise<string | null> => null),
    connect: vi.fn(async (distro: string) => {
      const opened = connection(distro)
      active.set(distro.toLowerCase(), opened)
      return opened
    }),
    get: vi.fn((distro: string) => active.get(distro.toLowerCase()) ?? null),
    forgetPairingFailures: vi.fn((_environmentId: string) => {}),
    isReachable: vi.fn(async (name: string) => active.has(name.toLowerCase())),
    isSettling: vi.fn((_distro: string) => false),
    reachability: vi.fn(async (name: string, _environmentId: string) =>
      active.has(name.toLowerCase())
        ? ('available' as const)
        : distro.state === 'running'
          ? ('unreachable' as const)
          : distro.state === 'stopped'
            ? ('stopped' as const)
            : ('unavailable' as const)
    ),
    disconnect: vi.fn(async (distro: string) => {
      active.delete(distro.toLowerCase())
    }),
    stopServer: vi.fn(
      async (_distro: string, _environmentId: string): Promise<WslHostServerStop> => ({
        stopped: true
      })
    ),
    releaseHolder: vi.fn(async (_distro: string) => {}),
    adoptHolders: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  } satisfies WslHostConnector
  return Object.assign(connector, { distro })
}

export const UBUNTU: WslHostDistroCandidate = {
  id: UBUNTU_ID,
  name: 'Ubuntu',
  state: 'running',
  version: 2
}
