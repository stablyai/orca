import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { wsPinnedBindServerOptions } from './rpc/ws-pinned-bind-config'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'

const holders: Server[] = []
const servers: OrcaRuntimeRpcServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    holders.splice(0).map((holder) => new Promise<void>((resolve) => holder.close(() => resolve())))
  )
  vi.restoreAllMocks()
})

async function listenLoopback(port: number): Promise<Server> {
  const holder = createServer()
  holders.push(holder)
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject)
    holder.listen(port, '127.0.0.1', () => resolve())
  })
  return holder
}

async function reserveFreePort(): Promise<number> {
  const scratch = createServer()
  await new Promise<void>((resolve) => scratch.listen(0, '127.0.0.1', () => resolve()))
  const address = scratch.address()
  await new Promise<void>((resolve) => scratch.close(() => resolve()))
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return address.port
}

// Why a real TCP connect: exposure is what another host can reach, not what the transport reports.
async function accepts(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function firstLanIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    const lan = addresses?.find((address) => address.family === 'IPv4' && !address.internal)
    if (lan) {
      return lan.address
    }
  }
  return null
}

function startPinned(
  userDataPath: string,
  config: Parameters<typeof wsPinnedBindServerOptions>[0]
): OrcaRuntimeRpcServer {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    ...wsPinnedBindServerOptions(config)
  })
  servers.push(server)
  return server
}

describe('OrcaRuntimeRpcServer desktop pinned WebSocket bind', () => {
  it('listens only on the pinned loopback host and port, ignoring a stale fallback port', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    const port = await reserveFreePort()
    const staleFallbackPort = await reserveFreePort()
    writeFileSync(
      join(userDataPath, FALLBACK_PORT_FILE),
      JSON.stringify({ port: staleFallbackPort })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const server = startPinned(userDataPath, { status: 'pinned', host: '127.0.0.1', port })
    await server.start()

    expect(server.getWebSocketStartFailure()).toBeNull()
    expect(server.getWebSocketEndpoint()).toBe(`ws://127.0.0.1:${port}`)
    expect(await accepts('127.0.0.1', port)).toBe(true)
    // Why: an IPv4 loopback bind must not also answer on IPv6 loopback or a LAN interface.
    expect(await accepts('::1', port)).toBe(false)
    const lan = firstLanIPv4()
    if (lan) {
      expect(await accepts(lan, port)).toBe(false)
    }
    expect(await accepts('127.0.0.1', staleFallbackPort)).toBe(false)
    expect(JSON.parse(readFileSync(join(userDataPath, FALLBACK_PORT_FILE), 'utf8'))).toEqual({
      port: staleFallbackPort
    })
  })

  it('refuses a pairing widen and keeps serving the pinned endpoint', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    const port = await reserveFreePort()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const server = startPinned(userDataPath, { status: 'pinned', host: '127.0.0.1', port })
    await server.start()

    await expect(server.ensureNetworkExposure()).rejects.toThrow(/refusing to widen/)
    const offer = await server.createMobilePairingOffer({
      address: '100.64.1.20',
      connectionMode: 'local-only'
    })
    expect(offer.available).toBe(false)
    expect(server.getWebSocketEndpoint()).toBe(`ws://127.0.0.1:${port}`)
    const lan = firstLanIPv4()
    if (lan) {
      expect(await accepts(lan, port)).toBe(false)
    }
  })

  it('fails closed when the pinned port is occupied instead of relocating', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    const port = await reserveFreePort()
    await listenLoopback(port)
    const staleFallbackPort = await reserveFreePort()
    writeFileSync(
      join(userDataPath, FALLBACK_PORT_FILE),
      JSON.stringify({ port: staleFallbackPort })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const server = startPinned(userDataPath, { status: 'pinned', host: '127.0.0.1', port })
    await server.start()

    // Why endpoint null proves no relocation: the default path would bind port 0 and publish it here.
    expect(server.getWebSocketEndpoint()).toBeNull()
    expect(server.getWebSocketStartFailure()).toMatchObject({ code: 'EADDRINUSE' })
    expect(await accepts('127.0.0.1', staleFallbackPort)).toBe(false)
    expect(JSON.parse(readFileSync(join(userDataPath, FALLBACK_PORT_FILE), 'utf8'))).toEqual({
      port: staleFallbackPort
    })
    // Why: pairing identity stays loaded so relay/push and the paired-device list keep working.
    expect(server.getDeviceRegistry()).not.toBeNull()
  })

  it('keeps the endpoint and the paired device across a restart once a network device connected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    // Why: unpinned, a connected network-reach device makes the next launch bind 0.0.0.0 (STA-2370).
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('Work PC', 'runtime', 'network')
    registry.updateLastSeen(device.deviceId)
    registry.flushPendingLastSeen()
    const port = await reserveFreePort()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const first = startPinned(userDataPath, { status: 'pinned', host: '127.0.0.1', port })
    await first.start()
    const publicKey = first.getE2EEPublicKey()
    await first.stop()

    const second = startPinned(userDataPath, { status: 'pinned', host: '127.0.0.1', port })
    await second.start()

    expect(second.getWebSocketEndpoint()).toBe(`ws://127.0.0.1:${port}`)
    expect(second.getE2EEPublicKey()).toBe(publicKey)
    expect(second.getDeviceRegistry()?.getDevice(device.deviceId)?.token).toBe(device.token)
    const lan = firstLanIPv4()
    if (lan) {
      expect(await accepts(lan, port)).toBe(false)
    }
  })

  it('does not listen at all when the pin is invalid', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const server = startPinned(userDataPath, { status: 'invalid', reason: '"port" must be ...' })
    await server.start()

    expect(server.getWebSocketEndpoint()).toBeNull()
    expect(String(server.getWebSocketStartFailure())).toMatch(/Invalid runtime-ws-bind\.json/)
    expect(server.getDeviceRegistry()).not.toBeNull()
  })

  it('keeps the default relocation when no pin is configured', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    const port = await reserveFreePort()
    await listenLoopback(port)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: port,
      ...wsPinnedBindServerOptions({ status: 'unset' })
    })
    servers.push(server)
    await server.start()

    const endpoint = server.getWebSocketEndpoint()
    expect(endpoint).not.toBeNull()
    expect(new URL(endpoint!).port).not.toBe(String(port))
    expect(server.getWebSocketStartFailure()).toBeNull()
  })
})
