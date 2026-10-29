import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import {
  probeThenWatchWslOrcadBridges,
  WSL_ORCAD_BRIDGE_EXIT_COOLDOWN_MS,
  WslOrcadBridgeActivity
} from './wsl-orcad-bridge-activity'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'
import type { WslOrcadWatch } from './wsl-orcad-watch'

const ENV = 'wsl:ubuntu'
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

/** Stands in for orcad: keeps every accepted socket so a test can end it from the guest side. */
async function fakeOrcad(): Promise<{ server: Server; port: number; accepted: Socket[] }> {
  const accepted: Socket[] = []
  const server = createServer((socket) => {
    accepted.push(socket)
    socket.on('error', () => {})
    socket.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => {
    for (const socket of accepted) {
      socket.destroy()
    }
    return new Promise((resolve) => server.close(resolve))
  })
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0, accepted }
}

async function bridgedHost(
  activity: WslOrcadBridgeActivity,
  orcad: { port: number; accepted: Socket[] }
) {
  const remotePort = orcad.port
  const children = fakeWslBridgeChildren()
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: ENV, distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const forward: StartedPortForward = await listenWslOrcadStdioBridge(
    transport,
    {
      environmentId: ENV,
      distro: 'Ubuntu',
      remotePort,
      localPort: 0,
      label: 'Ubuntu',
      events: activity.events(ENV)
    },
    {
      resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
      checkBridge: checkOrcadStdioBridge,
      openChannel: openOrcadStdioBridgeChannel
    }
  )
  cleanups.push(() => forward.close())
  // The listener's start-up check dials orcad once; let it land so tests count only their own.
  await expect.poll(() => orcad.accepted.length).toBe(1)
  return forward
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
    cleanups.push(() => socket.destroy())
  })
}

describe('the desktop’s bridged sockets as the liveness watch', () => {
  it('fires once when orcad ends a socket, and proves liveness only while one is open', async () => {
    const orcad = await fakeOrcad()
    const activity = new WslOrcadBridgeActivity()
    const forward = await bridgedHost(activity, orcad)
    const watch = activity.watch(ENV)
    const exits = vi.fn()
    watch.onExit(exits)
    expect(watch.proving()).toBe(false)

    const before = orcad.accepted.length
    await dial(forward.entry.localPort)
    await expect.poll(() => orcad.accepted.length).toBe(before + 1)
    await expect.poll(() => watch.proving()).toBe(true)

    // orcad exiting closes its end; the guest ends the bridge first.
    orcad.accepted.at(-1)?.destroy()
    await expect.poll(() => exits.mock.calls.length).toBe(1)
    expect(exits).toHaveBeenCalledWith(null)
    await expect.poll(() => watch.proving()).toBe(false)
  })

  it('stays quiet when orcad finishes a normal close while another socket is open', async () => {
    const orcad = await fakeOrcad()
    const activity = new WslOrcadBridgeActivity()
    const forward = await bridgedHost(activity, orcad)
    const watch = activity.watch(ENV)
    const exits = vi.fn()
    watch.onExit(exits)
    const before = orcad.accepted.length
    // The desktop's control socket stays open; a one-shot RPC socket comes and goes.
    await dial(forward.entry.localPort)
    const oneShot = await dial(forward.entry.localPort)
    await expect.poll(() => orcad.accepted.length).toBe(before + 2)
    // A WebSocket close: the client sends its close frame, the server ends the stream first.
    oneShot.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
    orcad.accepted.at(-1)?.end()
    await expect.poll(() => oneShot.destroyed || oneShot.readableEnded).toBe(true)
    oneShot.end()
    await expect.poll(() => orcad.accepted.at(-1)?.closed).toBe(true)
    expect(exits).not.toHaveBeenCalled()
    expect(activity.openSockets(ENV)).toBe(1)
    // orcad exiting then ends the last one: that is the exit signal.
    orcad.accepted.at(-2)?.destroy()
    await expect.poll(() => exits.mock.calls.length).toBe(1)
  })

  it('stays quiet when the desktop closes its own socket', async () => {
    const orcad = await fakeOrcad()
    const activity = new WslOrcadBridgeActivity()
    const forward = await bridgedHost(activity, orcad)
    const watch = activity.watch(ENV)
    const exits = vi.fn()
    watch.onExit(exits)
    const socket = await dial(forward.entry.localPort)
    await expect.poll(() => watch.proving()).toBe(true)

    socket.end()
    await expect.poll(() => watch.proving()).toBe(false)
    expect(exits).not.toHaveBeenCalled()
  })

  it('stops listening once closed, and keys hosts apart', () => {
    const activity = new WslOrcadBridgeActivity()
    const watch = activity.watch(ENV)
    const other = vi.fn()
    activity.watch('wsl:debian').onExit(other)
    const exits = vi.fn()
    watch.onExit(exits)
    watch.close()
    const events = activity.events(ENV)
    events.opened()
    events.ended(true)
    expect(exits).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
  })
})

describe('bridge activity signals', () => {
  it('coalesces a burst of exit signals into one, and reports the rest as idle', () => {
    let now = 0
    const activity = new WslOrcadBridgeActivity(() => now)
    const events = activity.events(ENV)
    const seen: string[] = []
    const watchOnce = (): void => {
      const watch = activity.watch(ENV)
      watch.onExit(() => seen.push('exit'))
      watch.onIdle?.(() => seen.push('idle'))
    }
    watchOnce()
    // One-shot sockets with nothing held: each ends on the guest side first.
    events.opened()
    events.ended(true)
    watchOnce()
    now += WSL_ORCAD_BRIDGE_EXIT_COOLDOWN_MS - 1
    events.opened()
    events.ended(true)
    now += 1
    events.opened()
    events.ended(true)
    expect(seen).toEqual(['exit', 'idle', 'exit'])
  })

  it('reports the last socket closing from the desktop side as idle, not exit', () => {
    const activity = new WslOrcadBridgeActivity(() => 0)
    const events = activity.events(ENV)
    const watch = activity.watch(ENV)
    const exits = vi.fn()
    const idles = vi.fn()
    watch.onExit(exits)
    watch.onIdle?.(idles)
    events.opened()
    events.opened()
    events.ended(false)
    expect(idles).not.toHaveBeenCalled()
    events.ended(false)
    expect(idles).toHaveBeenCalledOnce()
    expect(exits).not.toHaveBeenCalled()
  })
})

describe('probeThenWatchWslOrcadBridges', () => {
  const inert = (signal: WslOrcadWatch['signal']): WslOrcadWatch => ({
    signal,
    onExit: () => {},
    close: vi.fn(),
    proving: () => false
  })

  it('reports a refused or unverifiable probe as before, holding nothing', async () => {
    const activity = new WslOrcadBridgeActivity()
    for (const signal of ['refused', 'unverifiable'] as const) {
      const probe = inert(signal)
      await expect(probeThenWatchWslOrcadBridges(async () => probe, activity, ENV)).resolves.toBe(
        probe
      )
    }
  })

  it('closes the probe bridge once it proved the port, and watches the desktop’s sockets', async () => {
    const activity = new WslOrcadBridgeActivity()
    const probe = inert('ready')
    const watch = await probeThenWatchWslOrcadBridges(async () => probe, activity, ENV)
    expect(probe.close).toHaveBeenCalledOnce()
    expect(watch).not.toBe(probe)
    expect(watch.signal).toBe('ready')
  })
})
