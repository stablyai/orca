import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrcadStdioBridgeUnavailableError } from './orcad-host-unavailable'
import type { OrcadStdioBridge } from './orcad-stdio-bridge'
import {
  ORCAD_STDIO_BRIDGE_MAX_CHANNELS,
  OrcadStdioBridgePortForwardProvider
} from './orcad-stdio-bridge-provider'
import { spawnLocalBridgeChannel, startEchoServer } from './orcad-stdio-bridge-test-channel'
import { ORCAD_WINDOWS_HOST_SCRIPT } from './orcad-windows-host-script'
import type { SshConnection } from './ssh-connection'
import type { StartedPortForward } from './ssh-port-forward-provider'

let echo: { server: Server; port: number }
let script: string
let scratch: string
const started: StartedPortForward[] = []
const clients: Socket[] = []

beforeAll(async () => {
  echo = await startEchoServer()
  scratch = mkdtempSync(join(tmpdir(), 'orcad-stdio-provider-'))
  script = join(scratch, 'orcad-host-script.js')
  writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(started.splice(0).map((forward) => forward.close()))
})

afterAll(() => {
  echo.server.close()
  rmSync(scratch, { recursive: true, force: true })
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only getClient; exec goes through the injected openChannel.
const conn = { getClient: () => ({}) } as unknown as SshConnection
const bridge: OrcadStdioBridge = { command: 'bridge', mode: 'base64', wrapCommand: false }

/** The real bridge, run locally through the Windows host script's base64 framing. */
const localBridge = (): ClientChannel =>
  spawnLocalBridgeChannel(process.execPath, [script, 'stdio-bridge', String(echo.port)])

async function startProvider(
  overrides: Partial<ConstructorParameters<typeof OrcadStdioBridgePortForwardProvider>[0]> = {}
): Promise<StartedPortForward> {
  const provider = new OrcadStdioBridgePortForwardProvider({
    resolveBridge: async () => bridge,
    checkBridge: async () => 'running',
    openChannel: async () => localBridge(),
    ...overrides
  })
  const forward = await provider.start(conn, {
    id: 'pf-1',
    connectionId: 'ssh-1',
    localHost: '127.0.0.1',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort: echo.port
  })
  started.push(forward)
  return forward
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

const closedOf = (socket: Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))

describe('the managed tunnel over the stdio bridge', () => {
  it('serves the same local port a forward would, one bridge per connection', async () => {
    const openChannel = vi.fn(async () => localBridge())
    const forward = await startProvider({ openChannel })
    expect(forward.entry.localPort).toBeGreaterThan(0)
    const [first, second] = await Promise.all([
      dial(forward.entry.localPort),
      dial(forward.entry.localPort)
    ])
    expect(await echoOf(first, 'first')).toBe('first')
    expect(await echoOf(second, 'second')).toBe('second')
    expect(openChannel).toHaveBeenCalledTimes(2)
  })

  it('refuses to start where the bridge cannot run, so a deploy never registers it', async () => {
    const failure = new OrcadStdioBridgeUnavailableError('exit 127')
    await expect(
      startProvider({
        checkBridge: async () => {
          throw failure
        }
      })
    ).rejects.toBe(failure)
  })

  it('starts when the check only lost contact, resolving the bridge again per connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const resolveBridge = vi
      .fn<() => Promise<OrcadStdioBridge>>()
      .mockRejectedValueOnce(new Error('platform probe timed out'))
      .mockResolvedValue(bridge)
    const forward = await startProvider({ resolveBridge })
    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'after')).toBe('after')
    expect(resolveBridge).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('drops only the socket when its channel is lost, and keeps listening', async () => {
    const channels: PassThrough[] = []
    const openChannel = vi.fn(async () => {
      const channel = Object.assign(new PassThrough(), { stderr: new PassThrough(), close() {} })
      channels.push(channel)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider uses only the stream, `stderr`, `close`, and events.
      return channel as unknown as ClientChannel
    })
    const forward = await startProvider({ openChannel })
    const lost = await dial(forward.entry.localPort)
    await vi.waitFor(() => expect(channels).toHaveLength(1))
    channels[0].emit('close')
    await closedOf(lost)
    await dial(forward.entry.localPort)
    await vi.waitFor(() => expect(channels).toHaveLength(2))
  })

  it('caps concurrent bridges under sshd’s session limit and admits the next as one closes', async () => {
    const channels: PassThrough[] = []
    const openChannel = vi.fn(async () => {
      const channel = Object.assign(new PassThrough(), {
        stderr: new PassThrough(),
        close: () => channel.emit('close')
      })
      channels.push(channel)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider uses only the stream, `stderr`, `close`, and events.
      return channel as unknown as ClientChannel
    })
    const forward = await startProvider({ openChannel })
    const sockets = await Promise.all(
      Array.from({ length: ORCAD_STDIO_BRIDGE_MAX_CHANNELS + 1 }, () =>
        dial(forward.entry.localPort)
      )
    )
    await vi.waitFor(() =>
      expect(openChannel).toHaveBeenCalledTimes(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(openChannel).toHaveBeenCalledTimes(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    sockets[0].destroy()
    await vi.waitFor(() =>
      expect(openChannel).toHaveBeenCalledTimes(ORCAD_STDIO_BRIDGE_MAX_CHANNELS + 1)
    )
  })

  it('closes every bridge and connection when the tunnel closes', async () => {
    const forward = await startProvider()
    const socket = await dial(forward.entry.localPort)
    expect(await echoOf(socket, 'ping')).toBe('ping')
    await forward.close()
    await closedOf(socket)
  })
})
