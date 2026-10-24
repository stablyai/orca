import { connect, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import { ORCAD_STDIO_BRIDGE_MAX_CHANNELS } from '../managed-server/lifecycle/orcad-stdio-bridge-listener'
import { startEchoServer } from '../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

let echo: { server: Server; port: number }
const started: StartedPortForward[] = []
const clients: Socket[] = []

beforeAll(async () => {
  echo = await startEchoServer()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(started.splice(0).map((forward) => forward.close()))
})

afterAll(() => {
  echo.server.close()
})

async function startBridge(remotePort = echo.port, spares?: { spares: number; windowMs: number }) {
  const children = fakeWslBridgeChildren()
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const forward = await listenWslOrcadStdioBridge(
    transport,
    { environmentId: 'wsl:ubuntu', remotePort, localPort: 0, label: 'Ubuntu', spares },
    {
      resolveBridge: async (_conn, port) => posixOrcadStdioBridge(port),
      checkBridge: checkOrcadStdioBridge,
      openChannel: openOrcadStdioBridgeChannel
    }
  )
  started.push(forward)
  return { forward, children }
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
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('utf8')
      if (received.length >= message.length) {
        socket.off('data', onData)
        resolve(received)
      }
    }
    socket.on('data', onData)
    socket.write(message)
  })
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('listenWslOrcadStdioBridge (real listener, fake wsl.exe echo children)', () => {
  it('rides each accepted socket on its own wsl.exe bridge child', async () => {
    const { forward, children } = await startBridge()
    // The up-front check is one child; it has already exited.
    expect(children.commands).toHaveLength(1)
    await until(() => children.live() === 0)

    const first = await dial(forward.entry.localPort)
    const second = await dial(forward.entry.localPort)
    expect(await echoOf(first, 'one')).toBe('one')
    expect(await echoOf(second, 'two')).toBe('two')
    expect(children.commands).toHaveLength(3)
    expect(children.live()).toBe(2)
    for (const command of children.commands) {
      expect(command).toContain("'.orca-remote/runtimes/node-'*'/bin/node'")
      expect(command).toContain(` ${echo.port}; fi; done;`)
    }
  })

  it(`queues past ${ORCAD_STDIO_BRIDGE_MAX_CHANNELS} sockets and reuses freed slots`, async () => {
    const { forward, children } = await startBridge()
    await until(() => children.live() === 0)
    const count = ORCAD_STDIO_BRIDGE_MAX_CHANNELS + 4
    const sockets = await Promise.all(
      Array.from({ length: count }, () => dial(forward.entry.localPort))
    )
    const first = sockets.slice(0, ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    await Promise.all(first.map((socket, i) => echoOf(socket, `m${i}`)))
    expect(children.live()).toBe(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)

    for (const socket of first) {
      socket.destroy()
    }
    const rest = sockets.slice(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    expect(await Promise.all(rest.map((socket, i) => echoOf(socket, `q${i}`)))).toEqual(
      rest.map((_, i) => `q${i}`)
    )
    expect(children.maxLive()).toBe(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    expect(children.commands).toHaveLength(count + 1)
  })

  it('drops a socket whose bridge reports a refused port', async () => {
    const { forward, children } = await startBridge(1)
    const socket = await dial(forward.entry.localPort)
    await new Promise((resolve) => socket.once('close', resolve))
    await until(() => children.live() === 0)
  })

  it('hands a socket a bridge child opened ahead of it, then refills the spare', async () => {
    const { forward, children } = await startBridge(echo.port, { spares: 1, windowMs: 60_000 })
    // The check, then one spare that stays up waiting for a socket.
    await until(() => children.commands.length === 2 && children.live() === 1)

    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'spare')).toBe('spare')
    // The socket took the spare and a new one was opened behind it.
    await until(() => children.commands.length === 3 && children.live() === 2)
  })

  it('closes unused spares when the window ends, and opens one child per socket after', async () => {
    const { forward, children } = await startBridge(echo.port, { spares: 2, windowMs: 50 })
    await until(() => children.commands.length === 3)
    await until(() => children.live() === 0)

    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'late')).toBe('late')
    expect(children.commands).toHaveLength(4)
  })

  it('kills unused spares on close', async () => {
    const { forward, children } = await startBridge(echo.port, { spares: 2, windowMs: 60_000 })
    await until(() => children.live() === 2)
    await forward.close()
    await until(() => children.live() === 0)
  })

  it('kills every bridge child on close and stops listening', async () => {
    const { forward, children } = await startBridge()
    const sockets = await Promise.all([1, 2, 3].map(() => dial(forward.entry.localPort)))
    await Promise.all(sockets.map((socket, i) => echoOf(socket, `c${i}`)))
    expect(children.live()).toBe(3)

    await forward.close()
    await until(() => children.live() === 0)
    await expect(dial(forward.entry.localPort)).rejects.toThrow()
  })
})
