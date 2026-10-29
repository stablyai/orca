import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'

// Real gate and running-list cache; only the `wsl --list --running` probe is faked.
const probe = vi.hoisted(() => {
  const state: { running: string[]; calls: number } = { running: [], calls: 0 }
  return state
})
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return {
    ...actual,
    runProcess: async (spec: Parameters<typeof actual.runProcess>[0]) => {
      if (spec.args?.includes('--running')) {
        probe.calls += 1
        return {
          code: 0,
          signal: null,
          stdout: probe.running.map((distro) => `${distro}\n`).join(''),
          stderr: '',
          timedOut: false
        }
      }
      return actual.runProcess(spec)
    }
  }
})

import { _resetWslCachesForTests } from '../wsl'
import {
  _resetWslBackgroundDistroGateForTests,
  wasWslDistroLastSeenRunningSettled
} from '../wsl-background-distro-gate'
import { WslOrcadBridgeActivity, wslHostBridgeEvents } from './wsl-orcad-bridge-activity'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'
import { startOrcadStdioBridge } from '../managed-server/lifecycle/orcad-stdio-bridge-provider'

/** Echoes, and lets a test end every connection from the guest side. */
function startGuestServer(): Promise<{
  server: Server
  port: number
  endAll: () => void
  endOne: (index: number) => void
}> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.pipe(socket)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        server,
        port,
        endAll: () => sockets.forEach((socket) => socket.destroy()),
        endOne: (index: number) => [...sockets][index]?.destroy()
      })
    })
  })
}

const started: StartedPortForward[] = []
const clients: Socket[] = []
const servers: Server[] = []
const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  probe.running = []
  probe.calls = 0
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(started.splice(0).map((forward) => forward.close()))
  for (const server of servers.splice(0)) {
    server.close()
  }
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

async function startBridge() {
  const guest = await startGuestServer()
  servers.push(guest.server)
  const children = fakeWslBridgeChildren()
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn,
    commandLoops: false
  })
  const forward = await listenWslOrcadStdioBridge(
    transport,
    {
      environmentId: 'wsl:ubuntu',
      distro: 'Ubuntu',
      remotePort: guest.port,
      localPort: 0,
      label: 'Ubuntu',
      // Wired as the connector wires it.
      events: wslHostBridgeEvents(new WslOrcadBridgeActivity(), {
        environmentId: 'wsl:ubuntu',
        distro: 'Ubuntu'
      })
    },
    {
      resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
      checkBridge: checkOrcadStdioBridge,
      openChannel: openOrcadStdioBridgeChannel
    }
  )
  started.push(forward)
  // The listener's up-front check is one child; dials are counted after it.
  await vi.waitFor(() => expect(children.live()).toBe(0))
  return { forward, children, guest, transport }
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

const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))

describe('WSL bridge dials never start a stopped distro (E9)', () => {
  it('refuses a dial into a stopped distro without spawning wsl.exe', async () => {
    const { forward, children } = await startBridge()
    const spawnedBefore = children.commands.length
    const socket = await dial(forward.entry.localPort)
    await closed(socket)
    expect(children.commands).toHaveLength(spawnedBefore)
  })

  it('bridges a running distro, and many dials share one running read', async () => {
    probe.running = ['Ubuntu']
    const { forward } = await startBridge()
    const sockets = await Promise.all([1, 2, 3].map(() => dial(forward.entry.localPort)))
    expect(await Promise.all(sockets.map((socket, i) => echoOf(socket, `m${i}`)))).toEqual([
      'm0',
      'm1',
      'm2'
    ])
    expect(probe.calls).toBe(1)
  })

  it('after the guest ends a bridge, the next dial re-reads and is refused once stopped', async () => {
    probe.running = ['Ubuntu']
    const { forward, children, guest } = await startBridge()
    const first = await dial(forward.entry.localPort)
    expect(await echoOf(first, 'up')).toBe('up')
    const readsWhileUp = probe.calls

    // The distro stops: its side of every bridge ends first.
    probe.running = []
    guest.endAll()
    await closed(first)
    const spawnedBefore = children.commands.length
    const redial = await dial(forward.entry.localPort)
    await closed(redial)
    expect(probe.calls).toBeGreaterThan(readsWhileUp)
    expect(children.commands).toHaveLength(spawnedBefore)
  })

  it('a normal one-shot close while the control socket stays open costs the next dial nothing', async () => {
    probe.running = ['Ubuntu']
    const { forward, guest } = await startBridge()
    const control = await dial(forward.entry.localPort)
    expect(await echoOf(control, 'control')).toBe('control')
    const oneShot = await dial(forward.entry.localPort)
    expect(await echoOf(oneShot, 'rpc')).toBe('rpc')
    const readsBefore = probe.calls

    // The guest finishes the one-shot request first, as a WebSocket or RPC close does.
    guest.endOne(1)
    await closed(oneShot)
    // No stop note: the cached running read still answers, so no settle wait and no probe.
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu')).toBe(true)
    const next = await dial(forward.entry.localPort)
    expect(await echoOf(next, 'again')).toBe('again')
    expect(probe.calls).toBe(readsBefore)
    expect(await echoOf(control, 'still')).toBe('still')
  })

  it('a user act that starts the distro is not refused by the read taken before it', async () => {
    const { forward, children, transport } = await startBridge()
    // A background dial reads it stopped, and that read is cached.
    await closed(await dial(forward.entry.localPort))

    // The user's connect starts it (any wsl.exe launch does) before its clients dial.
    probe.running = ['Ubuntu']
    const launch = await transport.exec('true')
    launch.close()
    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'mine')).toBe('mine')
    expect(children.commands.length).toBeGreaterThan(2)
  })

  it('leaves the shared SSH bridge path ungated: it never reads WSL running state', async () => {
    const guest = await startGuestServer()
    servers.push(guest.server)
    const children = fakeWslBridgeChildren()
    const transport = createWslOrcadHostTransport({
      target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
      spawn: children.spawn,
      commandLoops: false
    })
    // The provider SSH uses, fed the same transport: no gate sits in the shared listener.
    const forward = await startOrcadStdioBridge(
      transport,
      {
        id: 'ssh:host',
        connectionId: 'ssh-1',
        localHost: '127.0.0.1',
        localPort: 0,
        remoteHost: '127.0.0.1',
        remotePort: guest.port,
        label: 'ssh'
      },
      {
        resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
        checkBridge: checkOrcadStdioBridge,
        openChannel: openOrcadStdioBridgeChannel
      }
    )
    started.push(forward)
    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'ssh')).toBe('ssh')
    expect(probe.calls).toBe(0)
  })
})
