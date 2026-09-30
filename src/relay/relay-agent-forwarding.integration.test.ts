import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { build } from 'esbuild'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import { agentLinkPathForRelaySocket } from './relay-agent-socket-binding'

const RELAY_TS_ENTRY = path.resolve(__dirname, 'relay.ts')

// Records the SSH_AUTH_SOCK every shell is spawned with, so the test sees exactly what a PTY gets.
const ENV_RECORDING_NODE_PTY = `const fs = require('node:fs')
module.exports = { spawn(_file, _args, opts) {
  fs.appendFileSync(process.env.ORCA_TEST_PTY_ENV_LOG,
    JSON.stringify({ sshAuthSock: opts.env.SSH_AUTH_SOCK ?? null }) + '\\n')
  return { pid: process.pid, process: 'mock-shell',
    onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, clear() {} }
} }\n`

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

let bundleDir: string
let relayEntry: string

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'relay-agent-bundle-'))
  relayEntry = path.join(bundleDir, 'relay.js')
  await build({
    entryPoints: [RELAY_TS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    sourcemap: false
  })
}, 30_000)

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
})

function readThroughSocket(socketPath: string): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const sock = createConnection({ path: socketPath })
    sock.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    sock.on('end', () => resolve(data))
    sock.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'))
  })
}

describe.skipIf(process.platform === 'win32')('relay agent forwarding across reconnects', () => {
  let dir: string
  let daemon: RelayProcess | null = null
  const bridges: RelayProcess[] = []
  const agents: Server[] = []

  async function listenAgent(name: string): Promise<string> {
    const socketPath = path.join(dir, name)
    const server = createServer((sock) => sock.end(name))
    agents.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return socketPath
  }

  async function connectBridge(sockPath: string, agentSocket?: string): Promise<RelayProcess> {
    const env = { ...process.env }
    delete env.SSH_AUTH_SOCK
    if (agentSocket) {
      env.SSH_AUTH_SOCK = agentSocket
    }
    const bridge = spawnRelay(relayEntry, ['--connect', '--sock-path', sockPath], { env })
    bridges.push(bridge)
    await bridge.sentinelReceived
    return bridge
  }

  async function closeBridge(bridge: RelayProcess): Promise<void> {
    const index = bridges.indexOf(bridge)
    if (index === -1) {
      return
    }
    bridges.splice(index, 1)
    bridge.kill('SIGTERM')
    await bridge.waitForExit().catch(() => {})
  }

  async function agentStatus(bridge: RelayProcess): Promise<unknown> {
    const resp = await bridge.waitForResponse(bridge.send('relay.status'))
    return readField(resp.result, 'agentForwarding')
  }

  async function spawnPtyAndReadAgent(bridge: RelayProcess, logPath: string): Promise<unknown> {
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').length : 0
    const resp = await bridge.waitForResponse(bridge.send('pty.spawn', { cols: 80, rows: 24 }))
    expect(resp.error).toBeUndefined()
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(before + 1)
    const record: unknown = JSON.parse(lines.at(-1) ?? '{}')
    return readField(record, 'sshAuthSock')
  }

  afterEach(async () => {
    // closeBridge removes each bridge from the list.
    for (let bridge = bridges.at(0); bridge; bridge = bridges.at(0)) {
      await closeBridge(bridge)
    }
    if (daemon) {
      daemon.kill('SIGKILL')
      await daemon.waitForExit().catch(() => {})
      daemon = null
    }
    await Promise.all(
      agents
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('keeps one SSH_AUTH_SOCK working for a shell across a reconnect', async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'relay-agent-')))
    const daemonEntry = path.join(dir, 'relay.js')
    copyFileSync(relayEntry, daemonEntry)
    const nodePtyDir = path.join(dir, 'node_modules', 'node-pty', 'lib')
    mkdirSync(nodePtyDir, { recursive: true })
    writeFileSync(path.join(nodePtyDir, 'index.js'), ENV_RECORDING_NODE_PTY)
    const logPath = path.join(dir, 'pty-env.log')
    const sockPath = path.join(dir, 'relay.sock')
    const linkPath = agentLinkPathForRelaySocket(sockPath)
    const firstAgent = await listenAgent('agent-a.sock')
    const secondAgent = await listenAgent('agent-b.sock')

    // The launch exec's socket is already gone by the time a shell starts (system ssh, no mux).
    daemon = spawnRelay(
      daemonEntry,
      ['--detached', '--grace-time', '60', '--sock-path', sockPath],
      {
        env: {
          ...process.env,
          SSH_AUTH_SOCK: path.join(dir, 'launch-session-gone.sock'),
          ORCA_TEST_PTY_ENV_LOG: logPath
        }
      }
    )
    await daemon.sentinelReceived

    const firstBridge = await connectBridge(sockPath, firstAgent)
    expect(await agentStatus(firstBridge)).toMatchObject({ supported: true, bound: true })
    expect(await spawnPtyAndReadAgent(firstBridge, logPath)).toBe(linkPath)
    expect(await readThroughSocket(linkPath)).toBe('agent-a.sock')

    // Connection drops: the old forwarded socket must not stay reachable through the link.
    await closeBridge(firstBridge)
    await expect.poll(() => existsSync(linkPath), { timeout: 5_000 }).toBe(false)

    // Reconnect: the shell from before still holds linkPath, which now reaches the new agent.
    const secondBridge = await connectBridge(sockPath, secondAgent)
    expect(await readThroughSocket(linkPath)).toBe('agent-b.sock')

    // A newer connection without forwarding clears the agent instead of borrowing the old one.
    const unforwardedBridge = await connectBridge(sockPath)
    expect(await agentStatus(unforwardedBridge)).toMatchObject({ bound: false })
    expect(await readThroughSocket(linkPath)).toBe('ENOENT')
    expect(await spawnPtyAndReadAgent(unforwardedBridge, logPath)).toBeNull()

    await closeBridge(unforwardedBridge)
    await expect.poll(() => readThroughSocket(linkPath), { timeout: 5_000 }).toBe('agent-b.sock')
    await closeBridge(secondBridge)
  }, 30_000)
})
