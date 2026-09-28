import '../daemon/mock-descendant-sweep'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonSocketPath } from '../daemon/daemon-spawner'
import { DaemonServer } from '../daemon/daemon-server'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { connectDaemonSocket } from '../daemon/daemon-client-socket-connect'
import { createMockSubprocess } from '../daemon/daemon-pty-adapter-test-harness'
import type * as DaemonProtocol from '../daemon/daemon-protocol-version'
import { WslDaemonSessions } from './wsl-daemon-sessions'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'
import type { WslDaemonRecovery } from '../../shared/wsl-daemon-recovery'
import { createWslDaemonTransport } from './wsl-daemon-transport'
import { prepareWslDaemonEndpoint, startRetainedWslDaemonOwner } from './wsl-daemon-endpoint'

// A v37 desktop reconnects to the original v36 guest, including records without metadata.
vi.mock('../daemon/daemon-protocol-version', async (original) => {
  const actual = await original<typeof DaemonProtocol>()
  return { ...actual, PROTOCOL_VERSION: 37, PREVIOUS_DAEMON_PROTOCOL_VERSIONS: [35, 36] }
})
vi.mock('./wsl-daemon-transport', () => ({ createWslDaemonTransport: vi.fn() }))
vi.mock('./wsl-daemon-endpoint', () => ({
  prepareWslDaemonEndpoint: vi.fn(),
  startPreparedWslDaemonOwner: vi.fn(),
  startRetainedWslDaemonOwner: vi.fn()
}))
vi.mock('./wsl-bun-runtime', () => ({
  createRunningWslRuntimeRunner: () => ({ run: async () => '/bin/bash' })
}))
vi.mock('./wsl-distribution-identity', () => ({
  readWslDistributionIdentity: async () => 'registration'
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  registerWslPtyProvider: vi.fn(() => () => {})
}))

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose()
  }
  vi.clearAllMocks()
})

async function fixture(protocolVersion?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'wsl-protocol-'))
  const socketPath = getDaemonSocketPath(dir, 36)
  const tokenPath = join(dir, 'token')
  const subprocess = createMockSubprocess()
  const spawn = vi.fn(() => subprocess)
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    protocolVersion: 36,
    spawnSubprocess: spawn,
    log: { log() {}, close() {} }
  })
  await server.start()
  cleanup.push(async () => {
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  const original = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 36 })
  cleanup.push(async () => original.disconnectOnly())
  const terminal = await original.spawn({ cols: 80, rows: 24, isNewSession: true })
  await original.disconnectOnly()
  vi.mocked(createWslDaemonTransport).mockReturnValue({
    readToken: () => readFileSync(tokenPath, 'utf8').trim(),
    connect: (_role, operation) => connectDaemonSocket(socketPath, operation.timeoutMs)
  })
  const owner = { distro: 'Ubuntu', relayBuildId: 'daemon+original+profile' }
  let record: WslDaemonRecovery = {
    kind: 'daemon',
    ...owner,
    endpoint: {
      distro: owner.distro,
      distributionId: 'registration',
      userName: 'alice',
      userId: '1000',
      home: '/home/alice',
      runtime: '/bin/bun',
      entry: '/daemon.js',
      envBinary: '/usr/bin/env',
      socket: '/private/socket',
      tokenPath: '/private/token',
      serverBuildId: 'original',
      ...(protocolVersion === undefined ? {} : { protocolVersion })
    }
  }
  const store = {
    getWslDaemonRecovery: () => record,
    upsertWslDaemonRecovery: vi.fn(async (value: WslDaemonRecovery) => {
      record = value
    })
  }
  const sessions = new WslDaemonSessions({ store, profileScope: '/profile', historyRoot: dir })
  cleanup.push(() => sessions.dispose())
  return { sessions, owner, terminal, subprocess, spawn, store, endpoint: record.endpoint }
}

it.each([36, undefined])(
  'retains attach and control after upgrade with owner protocol %s',
  async (version) => {
    const { sessions, owner, terminal, subprocess, spawn } = await fixture(version)
    const { provider } = await sessions.reconnect(owner)
    const id = toAppWslPtyId(owner, terminal.id)
    await provider.attach(id)
    await provider.writeWithSettlement(id, 'retained input\r')
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledWith('retained input\r'))
    expect(spawn).toHaveBeenCalledOnce()
    expect(startRetainedWslDaemonOwner).not.toHaveBeenCalled()
    expect(subprocess.kill).not.toHaveBeenCalled()
    expect(await provider.probePtyLiveness(id)).toBe(true)
  }
)

it.each([35, 999])(
  'refuses unsupported protocol %s without rewriting, recovering or killing the live owner',
  async (version) => {
    const { sessions, owner, subprocess, store } = await fixture(version)
    await expect(sessions.reconnect(owner)).rejects.toThrow(`protocol ${version} is unsupported`)
    expect(createWslDaemonTransport).not.toHaveBeenCalled()
    expect(startRetainedWslDaemonOwner).not.toHaveBeenCalled()
    expect(store.upsertWslDaemonRecovery).not.toHaveBeenCalled()
    expect(subprocess.kill).not.toHaveBeenCalled()
  }
)

it('reuses a missing-version owner for fresh preparation of the same v36 artifact', async () => {
  const { sessions, owner, endpoint, spawn, store } = await fixture()
  const retained = await sessions.reconnect(owner)
  vi.mocked(prepareWslDaemonEndpoint).mockResolvedValue({
    owner,
    endpoint: { ...endpoint, protocolVersion: 36 },
    entry: endpoint.entry,
    path: '/bin',
    artifactId: endpoint.serverBuildId
  })
  const fresh = await sessions.prepareFresh(owner.distro)
  expect(fresh.connection).toBe(retained)
  await fresh.connection.provider.spawn({ cols: 80, rows: 24, isNewSession: true })
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(store.getWslDaemonRecovery().endpoint).toEqual(endpoint)
  expect(startRetainedWslDaemonOwner).not.toHaveBeenCalled()
})

it.each([{ protocolVersion: 37 }, { userName: 'bob' }])(
  'refuses a changed owner endpoint after missing-version reconnect: %s',
  async (change) => {
    const { sessions, owner, endpoint } = await fixture()
    await sessions.reconnect(owner)
    vi.mocked(prepareWslDaemonEndpoint).mockResolvedValue({
      owner,
      endpoint: { ...endpoint, protocolVersion: 36, ...change },
      entry: endpoint.entry,
      path: '/bin',
      artifactId: endpoint.serverBuildId
    })
    await expect(sessions.prepareFresh(owner.distro)).rejects.toThrow('cannot change')
    expect(startRetainedWslDaemonOwner).not.toHaveBeenCalled()
  }
)
