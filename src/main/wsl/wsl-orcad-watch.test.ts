import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { watchChannel } from './wsl-orcad-watch'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function orcadLike(): Promise<{ port: number; sockets: Socket[] }> {
  const sockets: Socket[] = []
  const server = createServer((socket) => sockets.push(socket))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { port: typeof address === 'object' && address ? address.port : 0, sockets }
}

async function openWatch(port: number) {
  const children = fakeWslBridgeChildren()
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const channel = await openOrcadStdioBridgeChannel(transport, posixOrcadStdioBridge(port))
  return { watch: await watchChannel(channel, 5_000), children }
}

describe('watchChannel', () => {
  it('holds a ready bridge and reports its exit code when orcad closes it', async () => {
    const orcad = await orcadLike()
    const { watch } = await openWatch(orcad.port)
    expect(watch.signal).toBe('ready')
    const exited = new Promise<number | null>((resolve) => watch.onExit(resolve))
    await new Promise((resolve) => setTimeout(resolve, 20))
    orcad.sockets[0].destroy()
    expect(await exited).toBe(0)
  })

  it('reads a refused port as refused and holds nothing', async () => {
    const orcad = await orcadLike()
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()))
    const { watch, children } = await openWatch(orcad.port)
    expect(watch.signal).toBe('refused')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
  })

  it('never reports an exit it caused itself', async () => {
    const orcad = await orcadLike()
    const { watch, children } = await openWatch(orcad.port)
    let reported = false
    watch.onExit(() => {
      reported = true
    })
    watch.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
    expect(reported).toBe(false)
  })
})
