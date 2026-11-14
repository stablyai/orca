import { connect, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  encodePairingOffer,
  parsePairingCode
} from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { ServeReadiness } from '../../server/serve-readiness'
import { OrcadManagedIdentityError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import {
  ManagedOrcadPairingRepairs,
  type ManagedOrcadPairingRepairDeps
} from '../../managed-server/lifecycle/orcad-managed-pairing-repair'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  checkOrcadStdioBridge,
  openOrcadStdioBridgeChannel
} from '../../managed-server/lifecycle/orcad-stdio-bridge'
import { startEchoServer } from '../../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import {
  fakeWslBridgeChildren,
  posixOrcadStdioBridge
} from './__tests__/wsl-orcad-bridge-test-child'
import { WslOrcadConnectionManager } from './wsl-orcad-connection'
import type {
  WslOrcadConnection,
  WslOrcadConnectionDependencies
} from './wsl-orcad-connection-types'
import { WslOrcadConnectionSupersededError } from './wsl-orcad-connection-errors'
import type { WslOrcadLaunch } from './wsl-orcad-launch-contract'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

let first: { server: Server; port: number }
let second: { server: Server; port: number }
const managers: WslOrcadConnectionManager[] = []
const clients: Socket[] = []

beforeAll(async () => {
  first = await startEchoServer()
  second = await startEchoServer()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
})

afterAll(() => {
  first.server.close()
  second.server.close()
})

function readiness(port: number, deviceToken = 'device-token'): ServeReadiness {
  const endpoint = `ws://127.0.0.1:${port}`
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken,
        publicKeyB64: 'public-key',
        pairedDeviceId: 'device-1'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

function ready(port: number, deviceToken?: string): Extract<WslOrcadLaunch, { outcome: 'ready' }> {
  return {
    outcome: 'ready',
    distro: 'Ubuntu',
    distroId: null,
    port,
    fullVersion: '1.0.0',
    pid: 42,
    readiness: readiness(port, deviceToken),
    holder: 'adopted'
  }
}

function setup(overrides: Partial<WslOrcadConnectionDependencies> = {}) {
  const children = fakeWslBridgeChildren()
  const launches: WslOrcadLaunch[] = []
  const deployAndLaunch = vi.fn(async () => launches.shift() ?? ready(first.port))
  const onChange = vi.fn()
  const manager = new WslOrcadConnectionManager({
    deployAndLaunch,
    createTransport: (target) => createWslOrcadHostTransport({ target, spawn: children.spawn }),
    listen: (transport, options) =>
      listenWslOrcadStdioBridge(transport, options, {
        resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
        checkBridge: checkOrcadStdioBridge,
        openChannel: openOrcadStdioBridgeChannel
      }),
    verifyIdentity: async () => ({ verdict: 'verified' }),
    onChange,
    ...overrides
  })
  managers.push(manager)
  return { manager, children, launches, deployAndLaunch, onChange }
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
    clients.push(socket)
  })
}

function echoOf(socket: Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.length >= message.length) {
        resolve(received)
      }
    })
    socket.write(message)
  })
}

async function roundTrip(connection: WslOrcadConnection, message: string): Promise<string> {
  return echoOf(await dial(connection.localPort), message)
}

describe('WslOrcadConnectionManager', () => {
  it('moves the bridge to the new port after a relaunch, on the same local port', async () => {
    const { manager, launches, children } = setup()
    const before = await manager.ensure('Ubuntu')
    const stale = await dial(before.localPort)
    expect(await echoOf(stale, 'old')).toBe('old')
    const staleClosed = new Promise((resolve) => stale.once('close', resolve))

    launches.push(ready(second.port))
    const after = await manager.ensure('Ubuntu')
    expect(after).not.toBe(before)
    expect(after.remotePort).toBe(second.port)
    expect(after.localPort).toBe(before.localPort)
    expect(after.pairingOffer).toBe(before.pairingOffer)
    await staleClosed
    expect(await roundTrip(after, 'new')).toBe('new')
    expect(children.commands.at(-1)).toContain(` ${second.port}; fi; done;`)
  })

  it('drops a connect that a close overtook', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { manager } = setup({
      deployAndLaunch: async () => {
        await gate
        return ready(first.port)
      }
    })
    const pending = manager.ensure('Ubuntu')
    await manager.close('Ubuntu')
    release()
    await expect(pending).rejects.toBeInstanceOf(WslOrcadConnectionSupersededError)
    expect(manager.get('Ubuntu')).toBeNull()
  })
})

describe('a WSL host that refuses the enrolled pairing', () => {
  function offerCode(deviceToken: string, publicKeyB64 = 'public-key'): string {
    return encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:41000',
      deviceToken,
      publicKeyB64
    })
  }

  /** An in-memory pairing store and the managed repair gate over it. */
  function repairable(published: ServeReadiness) {
    let stored: KnownRuntimeEnvironment = createEnvironmentFromPairingOffer({
      id: 'wsl:ubuntu',
      name: 'Ubuntu',
      now: 1,
      offer: parsePairingCode(offerCode('lost-token'))!
    })
    const refresh = vi.fn((environmentId: string, pairingCode: string) => {
      stored = createEnvironmentFromPairingOffer({
        id: environmentId,
        name: 'Ubuntu',
        now: 2,
        offer: parsePairingCode(pairingCode)!
      })
      return stored
    })
    const deps: ManagedOrcadPairingRepairDeps = {
      resolve: () => stored,
      connect: async () => {
        const target = { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' } as const
        // The fixture supplies readiness, so this spawner is unused.
        const spawn = fakeWslBridgeChildren().spawn
        return { target, connection: createWslOrcadHostTransport({ target, spawn }) }
      },
      readReadiness: async () => published,
      ports: () => ({ localPort: 41000, remotePort: 6790 }),
      refresh,
      repaired: vi.fn(),
      now: () => 1_000
    }
    const recovery = { repairs: new ManagedOrcadPairingRepairs(deps), resolve: deps.resolve }
    return { stored: () => stored, refresh, recovery }
  }

  // After registry loss, only the newly published token authenticates.
  const verifyIdentity = async (pairingOffer: string) =>
    parsePairingCode(pairingOffer)?.deviceToken === 'fresh-token'
      ? ({ verdict: 'verified' } as const)
      : ({ verdict: 'unpaired', detail: 'access grant refused' } as const)

  it('never gives the token to a server under another host key', async () => {
    const published = readiness(first.port, 'fresh-token')
    if (!published.pairing.available) {
      throw new Error('fixture readiness publishes a pairing offer')
    }
    const store = repairable({
      ...published,
      pairing: { ...published.pairing, url: offerCode('fresh-token', 'another-key') }
    })
    const { manager } = setup({
      verifyIdentity,
      pairingRecovery: store.recovery,
      getPairingOffer: () => getPreferredPairingOffer(store.stored())
    })
    await expect(manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })).rejects.toBeInstanceOf(
      OrcadManagedIdentityError
    )
    expect(store.refresh).not.toHaveBeenCalled()
    expect(getPreferredPairingOffer(store.stored()).deviceToken).toBe('lost-token')
  })
})
