import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkOrcadStdioBridge,
  openOrcadStdioBridgeChannel
} from '../../managed-server/lifecycle/orcad-stdio-bridge'
import type { StartedPortForward } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { WslOrcadBridgeActivity } from './wsl-orcad-bridge-activity'
import {
  fakeWslBridgeChildren,
  posixOrcadStdioBridge
} from './__tests__/wsl-orcad-bridge-test-child'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

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
})

describe('bridge activity signals', () => {
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
