import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import { OrcadManagedIdentityError } from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import {
  ManagedOrcadPairingRepairs,
  type ManagedOrcadPairingRepairDeps
} from '../managed-server/lifecycle/orcad-managed-pairing-repair'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import { startEchoServer } from '../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import {
  WslOrcadConnectionManager,
  type WslOrcadConnection,
  type WslOrcadConnectionDependencies
} from './wsl-orcad-connection'
import {
  WslOrcadConnectionSupersededError,
  WslOrcadLaunchDeferredError
} from './wsl-orcad-connection-errors'
import type { WslOrcadLaunch } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'
import { wslOrcadHostDistro } from './wsl-orcad-host-environments'

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

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('WslOrcadConnectionManager', () => {
  it('rewrites the pairing offer to the local bridge port and nothing else', async () => {
    const { manager, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')

    expect(connection).toMatchObject({
      distro: 'Ubuntu',
      environmentId: 'wsl:ubuntu',
      remotePort: first.port,
      fullVersion: '1.0.0'
    })
    expect(connection.localPort).not.toBe(first.port)
    expect(parsePairingCode(connection.pairingOffer)).toEqual({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://127.0.0.1:${connection.localPort}/`,
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      pairedDeviceId: 'device-1'
    })
    expect(onChange.mock.calls).toEqual([
      ['Ubuntu', null, { state: 'connecting' }],
      ['Ubuntu', connection, { state: 'ready', census: null }]
    ])
    expect(connection.pid).toBe(42)
    expect(await roundTrip(connection, 'hello')).toBe('hello')
  })

  it('shares one deploy and one bridge between concurrent connects to a distro', async () => {
    const { manager, deployAndLaunch, children } = setup()
    const [a, b] = await Promise.all([manager.ensure('Ubuntu'), manager.ensure('ubuntu ')])
    expect(a).toBe(b)
    expect(deployAndLaunch).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([a])
    expect(manager.get('UBUNTU')).toBe(a)
    expect(children.commands).toHaveLength(1)
  })

  it('keeps the bridge when orcad still listens on the same port', async () => {
    const { manager, children, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port))
    expect(await manager.ensure('Ubuntu')).toBe(connection)
    expect(children.commands).toHaveLength(1)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('keeps its client grant when a relaunch advertises a new pairing offer', async () => {
    const { manager, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port, 'rotated-token'))
    const refreshed = await manager.ensure('Ubuntu')
    expect(refreshed.localPort).toBe(connection.localPort)
    expect(refreshed.pairingOffer).toBe(connection.pairingOffer)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

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

  it('rebinds the bridge port the host record saved, so an app restart keeps the pairing', async () => {
    const saved = await setup().manager.ensure('Ubuntu')
    const port = saved.localPort
    await saved.close()

    const { manager } = setup({ recordedLocalPort: () => port })
    const restarted = await manager.ensure('Ubuntu')
    expect(restarted.localPort).toBe(port)
    expect(restarted.pairingOffer).toBe(saved.pairingOffer)
    expect(await roundTrip(restarted, 'again')).toBe('again')
  })

  it('picks a free port when the recorded one is taken', async () => {
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    const address = squatter.address()
    const taken = typeof address === 'object' && address ? address.port : 0
    try {
      const { manager } = setup({ recordedLocalPort: () => taken })
      const connection = await manager.ensure('Ubuntu')
      expect(connection.localPort).not.toBe(taken)
      expect(await roundTrip(connection, 'free')).toBe('free')
    } finally {
      squatter.close()
    }
  })

  it('serves the incumbent with its deferred update, then reports the update landing', async () => {
    const { manager, launches, onChange, deployAndLaunch } = setup()
    const deferredUpdate = {
      candidateVersion: '2.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are running.',
      forceable: true
    }
    launches.push({ ...ready(first.port), deferredUpdate })
    const incumbent = await manager.ensure('Ubuntu')
    expect(incumbent.deferredUpdate).toEqual(deferredUpdate)
    launches.push({ ...ready(first.port), fullVersion: '2.0.0' })
    const updated = await manager.ensure('Ubuntu', { intent: 'force' })
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({ intent: 'force' })
    )
    expect(updated).toMatchObject({
      fullVersion: '2.0.0',
      deferredUpdate: null
    })
    expect(onChange).toHaveBeenLastCalledWith('Ubuntu', updated, {
      state: 'ready',
      census: null
    })
  })

  it('runs a forced connect after a plain one in flight instead of joining it', async () => {
    const { manager, deployAndLaunch } = setup()
    const plain = manager.ensure('Ubuntu')
    const forced = manager.ensure('Ubuntu', { intent: 'force' })
    await Promise.all([plain, forced])
    expect(deployAndLaunch).toHaveBeenCalledTimes(2)
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({ intent: 'force' })
    )
  })

  it('drops a queued forced connect that a close overtook', async () => {
    const { manager, deployAndLaunch } = setup()
    const plain = manager.ensure('Ubuntu')
    const forced = manager.ensure('Ubuntu', { intent: 'force' })
    await manager.close('Ubuntu')
    await plain.catch(() => {})
    await expect(forced).rejects.toBeInstanceOf(WslOrcadConnectionSupersededError)
    expect(deployAndLaunch).toHaveBeenCalledTimes(1)
  })

  it("hands the deploy this desktop's enrolled pairing for the incumbent's terminal count", async () => {
    const enrolled = parsePairingCode(
      encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: 'ws://127.0.0.1:41000',
        deviceToken: 'enrolled-token',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64')
      })
    )
    const { manager, deployAndLaunch } = setup({ getPairingOffer: () => enrolled })
    await manager.ensure('Ubuntu')
    expect(deployAndLaunch).toHaveBeenCalledWith(
      'Ubuntu',
      expect.objectContaining({ pairedOffer: enrolled })
    )
  })

  it('throws the deferral and starts no bridge', async () => {
    const { manager, launches, children, onChange } = setup()
    launches.push({
      outcome: 'deferred',
      distro: 'Ubuntu',
      candidateVersion: '2.0.0',
      code: 'live_terminals',
      reason: 'Terminals are running.',
      forceable: true
    })
    await expect(manager.ensure('Ubuntu')).rejects.toBeInstanceOf(WslOrcadLaunchDeferredError)
    expect(children.commands).toHaveLength(0)
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(
      'Ubuntu',
      null,
      expect.objectContaining({
        state: 'failed',
        deferredUpdate: {
          candidateVersion: '2.0.0',
          code: 'live_terminals',
          reason: 'Terminals are running.',
          forceable: true
        }
      })
    )
  })

  it('refuses a foreign server behind the port and closes its bridge', async () => {
    const { manager, children, onChange } = setup({
      verifyIdentity: async () => ({ verdict: 'foreign', detail: 'another runtime' })
    })
    await expect(manager.ensure('Ubuntu')).rejects.toBeInstanceOf(OrcadManagedIdentityError)
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(
      'Ubuntu',
      null,
      expect.objectContaining({ state: 'failed', terminals: 'unverifiable' })
    )
    await until(() => children.live() === 0)
  })

  it('reports the caller-supplied statuses for a liveness reconnect, even when nothing changed', async () => {
    const { manager, launches, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    launches.push(ready(first.port))
    const pending = {
      state: 'reconnecting',
      reason: 'orcad-exited',
      attempt: 1,
      retryInMs: null,
      terminals: 'unverifiable'
    } as const
    const census = { ...pending, reason: 'census' } as const
    await manager.ensure('Ubuntu', { status: { pending, ready: census } })
    expect(onChange.mock.calls.slice(-2)).toEqual([
      ['Ubuntu', connection, pending],
      ['Ubuntu', connection, census]
    ])
    manager.publish('Ubuntu', { state: 'ready', census: null })
    expect(onChange).toHaveBeenLastCalledWith('Ubuntu', connection, {
      state: 'ready',
      census: null
    })
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

  it('tears down every bridge child and the listener on close', async () => {
    const { manager, children, onChange } = setup()
    const connection = await manager.ensure('Ubuntu')
    const sockets = await Promise.all([1, 2, 3].map(() => dial(connection.localPort)))
    await Promise.all(sockets.map((socket, i) => echoOf(socket, `s${i}`)))
    expect(children.live()).toBe(3)

    await connection.close()
    await until(() => children.live() === 0)
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith('Ubuntu', null, { state: 'closed' })
    await expect(dial(connection.localPort)).rejects.toThrow()
  })

  it('lists its environment as a WSL host only while the connection is open', async () => {
    const { manager } = setup()
    const connection = await manager.ensure('Ubuntu')
    expect(wslOrcadHostDistro(connection.environmentId)).toBe('Ubuntu')
    await connection.close()
    expect(wslOrcadHostDistro(connection.environmentId)).toBeNull()
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

  it('heals on the next connect, and the next update counts terminals with the new pairing', async () => {
    const store = repairable(readiness(first.port, 'fresh-token'))
    const { manager, deployAndLaunch } = setup({
      verifyIdentity,
      pairingRecovery: store.recovery,
      getPairingOffer: () => getPreferredPairingOffer(store.stored())
    })
    const connection = await manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    expect(parsePairingCode(connection.pairingOffer)?.deviceToken).toBe('fresh-token')
    expect(store.refresh).toHaveBeenCalledOnce()
    await manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({
        pairedOffer: expect.objectContaining({ deviceToken: 'fresh-token' })
      })
    )
  })

  it('retires the bridge when the repaired pairing is refused too, so no failure stores the old token', async () => {
    const store = repairable(readiness(first.port, 'fresh-token'))
    let hostLostRegistry = false
    const onChange = vi.fn()
    const { manager } = setup({
      // Registry loss invalidates the previously enrolled token.
      verifyIdentity: async (pairingOffer: string) =>
        !hostLostRegistry && parsePairingCode(pairingOffer)?.deviceToken === 'lost-token'
          ? ({ verdict: 'verified' } as const)
          : ({ verdict: 'unpaired', detail: 'access grant refused' } as const),
      pairingRecovery: store.recovery,
      getPairingOffer: () => getPreferredPairingOffer(store.stored()),
      onChange
    })
    await manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    hostLostRegistry = true
    await expect(manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })).rejects.toThrow()
    expect(manager.get('Ubuntu')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(
      'Ubuntu',
      null,
      expect.objectContaining({ state: 'failed' })
    )
    expect(getPreferredPairingOffer(store.stored()).deviceToken).toBe('fresh-token')
  })

  it('still runs an Update queued behind a reconnect whose pairing failed', async () => {
    const store = repairable(readiness(first.port, 'fresh-token'))
    let hostLostRegistry = false
    const { manager, deployAndLaunch } = setup({
      verifyIdentity: async (pairingOffer: string) =>
        !hostLostRegistry && parsePairingCode(pairingOffer)?.deviceToken === 'lost-token'
          ? ({ verdict: 'verified' } as const)
          : ({ verdict: 'unpaired', detail: 'access grant refused' } as const),
      pairingRecovery: store.recovery,
      getPairingOffer: () => getPreferredPairingOffer(store.stored())
    })
    await manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    hostLostRegistry = true
    const reconnect = manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    const update = manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu', intent: 'update' })
    await reconnect.catch(() => {})
    const settled = await update.then(
      () => null,
      (error: unknown) => error
    )
    expect(settled).not.toBeInstanceOf(WslOrcadConnectionSupersededError)
    expect(deployAndLaunch).toHaveBeenLastCalledWith(
      'Ubuntu',
      expect.objectContaining({ intent: 'update' })
    )
  })

  it('reuses the bridge of a host still being added, which has no stored pairing to repair', async () => {
    const store = repairable(readiness(first.port, 'fresh-token'))
    const resolve = vi.fn(() => {
      throw new Error('no environment is recorded for this host yet')
    })
    const { manager } = setup({
      pairingRecovery: { repairs: store.recovery.repairs, resolve },
      getPairingOffer: () => null
    })
    const opened = await manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })
    await expect(manager.ensure('Ubuntu', { environmentId: 'wsl:ubuntu' })).resolves.toMatchObject({
      pairingOffer: opened.pairingOffer
    })
    expect(resolve).not.toHaveBeenCalled()
  })

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
