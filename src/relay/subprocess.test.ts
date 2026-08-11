import { afterAll, beforeAll, describe, expect, it, afterEach } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { build } from 'esbuild'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import { getEndpointFileName } from '../shared/agent-hook-listener'
import { relayTestSocketPath } from './relay-test-socket-path'

const RELAY_TS_ENTRY = path.resolve(__dirname, 'relay.ts')
const WATCHER_TS_ENTRY = path.resolve(__dirname, '../main/ipc/parcel-watcher-process-entry.ts')
let bundleDir: string
let relayEntry: string
const spawnedSocketDirs: string[] = []

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'relay-bundle-'))
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
  await build({
    entryPoints: [WATCHER_TS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(bundleDir, 'relay-watcher.js'),
    external: ['@parcel/watcher'],
    sourcemap: false
  })
}, 30_000)

afterAll(async () => {
  if (bundleDir) {
    await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
  }
})

function spawnRelayEntry(
  entryPath: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv
): RelayProcess {
  let relayArgs = args
  if (!args.includes('--sock-path')) {
    // Why: Windows relays require a named pipe; filesystem socket paths fail with EACCES.
    const socketDir = mkdtempSync(path.join(tmpdir(), 'relay-sock-'))
    spawnedSocketDirs.push(socketDir)
    relayArgs = [
      ...args,
      '--sock-path',
      relayTestSocketPath(socketDir),
      '--endpoint-dir',
      path.join(socketDir, 'agent-hooks')
    ]
  }
  return spawnRelay(entryPath, relayArgs, env ? { env } : undefined)
}

function spawn(args: string[] = [], env?: NodeJS.ProcessEnv): RelayProcess {
  return spawnRelayEntry(relayEntry, args, env)
}

function waitForChildExit(
  proc: ReturnType<typeof spawnChild>,
  timeoutMs = 5000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child exit')), timeoutMs)
    proc.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function writeMockNodePty(root: string, source: string, withPackageEntry = false): void {
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty')
  const libDir = path.join(nodePtyDir, 'lib')
  mkdirSync(libDir, { recursive: true })
  if (withPackageEntry) {
    writeFileSync(path.join(nodePtyDir, 'package.json'), '{"main":"lib/index.js"}\n')
  }
  writeFileSync(path.join(libDir, 'index.js'), source)
}

const WORKING_NODE_PTY_MODULE = `module.exports = { spawn() { return {
  pid: process.pid,
  process: 'mock-shell',
  onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, clear() {}
} } }\n`

// A shell that reports its own exit after a delay, so the relay sees the pool drain on its own.
function selfExitingNodePtyModule(exitAfterMs: number): string {
  return `module.exports = { spawn() {
  const exitHandlers = []
  setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, ${exitAfterMs})
  return {
    pid: process.pid,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, kill() {}, clear() {}
  }
} }\n`
}

// A shell whose first dispose is refused, so ptyHandler.dispose() rejects once before a retry can succeed.
const KILL_REJECTS_FIRST_DISPOSE_MODULE = `let killAttempts = 0
module.exports = { spawn() {
  const exitHandlers = []
  return {
    pid: 2147483646,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, clear() {},
    kill() {
      killAttempts++
      if (killAttempts <= 2) { throw new Error('kill refused') }
      setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, 0)
    }
  }
} }\n`

// Why: an ESM mock with top-level await parks loadPty() in the window where a spawn is admitted but not yet pooled.
function writeSlowLoadingNodePty(root: string, loadDelayMs: number): void {
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty')
  mkdirSync(path.join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(path.join(nodePtyDir, 'package.json'), '{"type":"module","main":"lib/index.js"}\n')
  writeFileSync(
    path.join(nodePtyDir, 'lib', 'index.js'),
    `await new Promise((resolve) => setTimeout(resolve, ${loadDelayMs}))
export function spawn() {
  const exitHandlers = []
  return {
    pid: process.pid,
    process: 'mock-shell',
    onData() {}, onExit(cb) { exitHandlers.push(cb) }, write() {}, resize() {}, clear() {},
    // Report the exit so relay shutdown can complete instead of parking on waitForPhysicalExit.
    kill() { setTimeout(() => { for (const cb of exitHandlers) { cb({ exitCode: 0, signal: 0 }) } }, 0) }
  }
}
`
  )
}

describe('Subprocess: Relay entry point', () => {
  let relay: RelayProcess | null = null
  let tmpDir: string

  afterEach(async () => {
    if (relay && relay.proc.exitCode === null) {
      relay.proc.kill('SIGKILL')
      await relay.waitForExit().catch(() => {})
    }
    relay = null
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
    while (spawnedSocketDirs.length > 0) {
      const socketDir = spawnedSocketDirs.pop()!
      await rm(socketDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('prints sentinel on startup', async () => {
    relay = spawn()
    await relay.sentinelReceived
  }, 10_000)

  it('keeps the Node-18 relay bundle free of unsupported array copy methods', () => {
    expect(readFileSync(relayEntry, 'utf8')).not.toContain('.toReversed(')
  })

  it('loads node-pty after an in-place dependency repair without restarting', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-native-repair-'))
    const repairedRelayEntry = path.join(tmpDir, 'relay.js')
    copyFileSync(relayEntry, repairedRelayEntry)

    relay = spawnRelayEntry(repairedRelayEntry)
    await relay.sentinelReceived

    const failedId = relay.send('pty.spawn', { cols: 80, rows: 24 })
    const failed = await relay.waitForResponse(failedId)
    expect(failed.error?.message).toContain('Remote terminals are unavailable')

    writeMockNodePty(tmpDir, WORKING_NODE_PTY_MODULE)

    const repairedId = relay.send('pty.spawn', { cols: 80, rows: 24 })
    const repaired = await relay.waitForResponse(repairedId)
    expect(repaired.error).toBeUndefined()
    expect(repaired.result).toMatchObject({ id: 'pty-1' })
  }, 10_000)

  it('reloads node-pty after a late native binding failure without restarting', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-native-late-repair-'))
    const repairedRelayEntry = path.join(tmpDir, 'relay.js')
    copyFileSync(relayEntry, repairedRelayEntry)
    writeMockNodePty(
      tmpDir,
      `module.exports = { spawn() { throw new Error('Failed to load native module: conpty.node, checked: prebuilds/win32-x64') } }\n`,
      true
    )

    relay = spawnRelayEntry(repairedRelayEntry)
    await relay.sentinelReceived

    const failedId = relay.send('pty.spawn', { cols: 80, rows: 24 })
    const failed = await relay.waitForResponse(failedId)
    expect(failed.error?.message).toContain('Remote terminals are unavailable')

    writeMockNodePty(tmpDir, WORKING_NODE_PTY_MODULE, true)
    const repairedId = relay.send('pty.spawn', { cols: 80, rows: 24 })
    const repaired = await relay.waitForResponse(repairedId)
    expect(repaired.error).toBeUndefined()
    expect(repaired.result).toMatchObject({ id: 'pty-2' })
  }, 10_000)

  it('responds to fs.stat over stdin/stdout', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.stat', { filePath: path.join(tmpDir, 'test.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.result).toBeDefined()
    const result = resp.result as { size: number; type: string }
    expect(result.type).toBe('file')
    expect(result.size).toBe(5)
  }, 10_000)

  it('responds to fs.readDir', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
    writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.readDir', { dirPath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const entries = resp.result as { name: string }[]
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'b.txt'])
  }, 10_000)

  it('responds to fs.readFile and fs.writeFile', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))

    relay = spawn()
    await relay.sentinelReceived

    const filePath = path.join(tmpDir, 'output.txt')
    const wId = relay.send('fs.writeFile', { filePath, content: 'via subprocess' })
    const wResp = await relay.waitForResponse(wId)
    expect(wResp.error).toBeUndefined()

    const rId = relay.send('fs.readFile', { filePath })
    const rResp = await relay.waitForResponse(rId)
    const result = rResp.result as { content: string; isBinary: boolean }
    expect(result.content).toBe('via subprocess')
    expect(result.isBinary).toBe(false)
  }, 10_000)

  it('responds to git.status on a real repo', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(path.join(tmpDir, 'file.txt'), 'dirty')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('git.status', { worktreePath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const result = resp.result as { entries: { path: string; status: string }[] }
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries[0].path).toBe('file.txt')
    expect(result.entries[0].status).toBe('modified')
  }, 10_000)

  it('returns JSON-RPC error for unknown method', async () => {
    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('does.not.exist', {})
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
    expect(resp.error!.code).toBe(-32601)
    expect(resp.error!.message).toContain('Method not found')
  }, 10_000)

  it('returns error for failing handler', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.readFile', { filePath: path.join(tmpDir, 'nonexistent.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
  }, 10_000)

  it('handles multiple concurrent requests', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'one.txt'), '1')
    writeFileSync(path.join(tmpDir, 'two.txt'), '22')
    writeFileSync(path.join(tmpDir, 'three.txt'), '333')

    relay = spawn()
    await relay.sentinelReceived

    const id1 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'one.txt') })
    const id2 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'two.txt') })
    const id3 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'three.txt') })

    const [r1, r2, r3] = await Promise.all([
      relay.waitForResponse(id1),
      relay.waitForResponse(id2),
      relay.waitForResponse(id3)
    ])

    expect((r1.result as { size: number }).size).toBe(1)
    expect((r2.result as { size: number }).size).toBe(2)
    expect((r3.result as { size: number }).size).toBe(3)
  }, 10_000)

  it('shuts down cleanly on SIGTERM', async () => {
    relay = spawn()
    await relay.sentinelReceived

    relay.kill('SIGTERM')
    await relay.waitForExit()
    expect(relay.proc.exitCode !== null || relay.proc.signalCode !== null).toBe(true)
  }, 10_000)

  it('exits after grace period on stdin close when no PTYs exist', async () => {
    // Why: grace timer always waits the full period now (even with zero PTYs)
    // so a detached relay has time for a --connect client to arrive.
    relay = spawn(['--grace-time', '1'])
    await relay.sentinelReceived

    relay.proc.stdin!.end()

    await relay.waitForExit(5000)
    expect(relay.proc.exitCode).toBe(0)
  }, 10_000)

  it.skipIf(process.platform === 'win32')(
    'refuses a duplicate detached daemon without unlinking the active relay socket',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-dup-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      relay = spawn(['--detached', '--grace-time', '10', '--sock-path', sockPath])
      await relay.sentinelReceived
      const endpointFile = path.join(tmpDir, 'agent-hooks', 'relay.sock', getEndpointFileName())
      const endpointBeforeDuplicate = readFileSync(endpointFile, 'utf8')

      let duplicateStderr = ''
      const duplicate = spawnChild(
        'node',
        [relayEntry, '--detached', '--grace-time', '10', '--sock-path', sockPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      duplicate.stderr!.on('data', (chunk: Buffer) => {
        duplicateStderr += chunk.toString('utf8')
      })

      const duplicateExit = await waitForChildExit(duplicate, 5000)
      expect(duplicateExit.code).toBe(1)
      expect(duplicateStderr).toContain('Socket path already in use')
      expect(readFileSync(endpointFile, 'utf8')).toBe(endpointBeforeDuplicate)

      const bridge = spawn(['--connect', '--sock-path', sockPath])
      try {
        await bridge.sentinelReceived
        const id = bridge.send('relay.status')
        const resp = await bridge.waitForResponse(id)
        expect(resp.error).toBeUndefined()
        expect(
          (resp.result as { socket: { path: string; acceptedConnections: number } }).socket
        ).toMatchObject({
          path: sockPath,
          acceptedConnections: 1
        })
      } finally {
        bridge.kill('SIGTERM')
        await bridge.waitForExit().catch(() => {})
      }
    },
    10_000
  )

  it.skipIf(process.platform === 'win32')(
    'reclaims a socket path left behind by a killed detached relay',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-stale-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      const first = spawn(['--detached', '--grace-time', '10', '--sock-path', sockPath])
      let bridge: RelayProcess | null = null
      try {
        await first.sentinelReceived

        first.kill('SIGKILL')
        await first.waitForExit(2000)
        expect(existsSync(sockPath)).toBe(true)

        relay = spawn(['--detached', '--grace-time', '10', '--sock-path', sockPath])
        await relay.sentinelReceived

        bridge = spawn(['--connect', '--sock-path', sockPath])
        await bridge.sentinelReceived
        const id = bridge.send('relay.status')
        const resp = await bridge.waitForResponse(id)
        expect(resp.error).toBeUndefined()
        expect(
          resp.result as {
            pid: number | undefined
            socket: { path: string; owned: boolean; listening: boolean }
          }
        ).toMatchObject({
          pid: relay.proc.pid,
          socket: { path: sockPath, owned: true, listening: true }
        })
      } finally {
        bridge?.kill('SIGTERM')
        await bridge?.waitForExit().catch(() => {})
        if (first.proc.exitCode === null && first.proc.signalCode === null) {
          first.kill('SIGKILL')
          await first.waitForExit().catch(() => {})
        }
      }
    },
    10_000
  )

  it.skipIf(process.platform === 'win32')(
    'does not unlink a newer relay socket when an older relay exits',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-rebound-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      const first = spawn(['--detached', '--grace-time', '10', '--sock-path', sockPath])
      let second: RelayProcess | null = null
      let bridge: RelayProcess | null = null
      try {
        await first.sentinelReceived
        unlinkSync(sockPath)

        second = spawn(['--detached', '--grace-time', '10', '--sock-path', sockPath])
        await second.sentinelReceived

        first.kill('SIGTERM')
        await first.waitForExit(2000)

        bridge = spawn(['--connect', '--sock-path', sockPath])
        await bridge.sentinelReceived
        const id = bridge.send('relay.status')
        const resp = await bridge.waitForResponse(id)
        expect(resp.error).toBeUndefined()
        expect((resp.result as { pid: number }).pid).toBe(second.proc.pid)
      } finally {
        bridge?.kill('SIGTERM')
        await bridge?.waitForExit().catch(() => {})
        first.kill('SIGTERM')
        await first.waitForExit().catch(() => {})
        second?.kill('SIGTERM')
        await second?.waitForExit().catch(() => {})
      }
    },
    10_000
  )

  it.skipIf(process.platform === 'win32')(
    'uses a short startup grace for empty detached relays before any client connects',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-empty-'))
      relay = spawn(
        ['--detached', '--grace-time', '10', '--sock-path', path.join(tmpDir, 'relay.sock')],
        { ...process.env, ORCA_RELAY_EMPTY_STARTUP_GRACE_MS: '100' }
      )
      await relay.sentinelReceived

      await relay.waitForExit(3000)
      expect(relay.proc.exitCode).toBe(0)
    },
    10_000
  )

  it.skipIf(process.platform === 'win32')(
    'uses a short startup grace for unlimited empty detached relays before any client connects',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-empty-unlimited-'))
      relay = spawn(
        ['--detached', '--grace-time', '0', '--sock-path', path.join(tmpDir, 'relay.sock')],
        { ...process.env, ORCA_RELAY_EMPTY_STARTUP_GRACE_MS: '100' }
      )
      await relay.sentinelReceived

      await relay.waitForExit(3000)
      expect(relay.proc.exitCode).toBe(0)
    },
    10_000
  )

  it.skipIf(process.platform === 'win32')(
    'uses configured grace after a detached relay has accepted a socket client',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-connected-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      relay = spawn(['--detached', '--grace-time', '1', '--sock-path', sockPath], {
        ...process.env,
        ORCA_RELAY_EMPTY_STARTUP_GRACE_MS: '500'
      })
      await relay.sentinelReceived

      const bridge = spawn(['--connect', '--sock-path', sockPath])
      try {
        await bridge.sentinelReceived
      } finally {
        bridge.kill('SIGTERM')
        await bridge.waitForExit().catch(() => {})
      }

      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(relay.proc.exitCode).toBeNull()

      await relay.waitForExit(2000)
      expect(relay.proc.exitCode).toBe(0)
    },
    10_000
  )

  // Why: a relay holding zero PTYs preserves nothing, so the unlimited default must still be
  // bounded once a client has come and gone — but an explicitly configured grace is never shortened.
  function spawnIdleGraceDaemon(
    nodePtyModule: string,
    graceTimeSeconds: string,
    idleGraceMs: string
  ): { daemon: RelayProcess; sockPath: string } {
    const daemonEntry = path.join(tmpDir, 'relay.js')
    copyFileSync(relayEntry, daemonEntry)
    writeMockNodePty(tmpDir, nodePtyModule)
    const sockPath = path.join(tmpDir, 'relay.sock')
    const daemon = spawnRelayEntry(
      daemonEntry,
      ['--detached', '--grace-time', graceTimeSeconds, '--sock-path', sockPath],
      { ...process.env, ORCA_RELAY_IDLE_GRACE_MS: idleGraceMs }
    )
    return { daemon, sockPath }
  }

  async function connectAndDisconnect(
    sockPath: string,
    whileConnected?: (bridge: RelayProcess) => Promise<void>
  ): Promise<void> {
    const bridge = spawn(['--connect', '--sock-path', sockPath])
    try {
      await bridge.sentinelReceived
      await whileConnected?.(bridge)
    } finally {
      bridge.kill('SIGTERM')
      await bridge.waitForExit().catch(() => {})
    }
  }

  it.skipIf(process.platform === 'win32')(
    'shuts down an idle relay with no PTYs after the idle grace even with --grace-time 0',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-idle-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      relay = spawn(['--detached', '--grace-time', '0', '--sock-path', sockPath], {
        ...process.env,
        ORCA_RELAY_IDLE_GRACE_MS: '200'
      })
      await relay.sentinelReceived

      // Accepting a client defeats the startup-empty branch, so only the idle cap can end this relay.
      await connectAndDisconnect(sockPath)

      await relay.waitForExit(2000)
      expect(relay.proc.exitCode).toBe(0)
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'keeps a relay with a live PTY alive past the idle grace',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-idle-live-pty-'))
      const { daemon, sockPath } = spawnIdleGraceDaemon(WORKING_NODE_PTY_MODULE, '0', '200')
      relay = daemon
      await relay.sentinelReceived

      await connectAndDisconnect(sockPath, async (bridge) => {
        const resp = await bridge.waitForResponse(bridge.send('pty.spawn', { cols: 80, rows: 24 }))
        expect(resp.error).toBeUndefined()
      })

      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(relay.proc.exitCode).toBeNull()
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    're-arms the idle grace when the last PTY exits during grace',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-idle-rearm-'))
      const { daemon, sockPath } = spawnIdleGraceDaemon(selfExitingNodePtyModule(1500), '0', '200')
      relay = daemon
      await relay.sentinelReceived

      await connectAndDisconnect(sockPath, async (bridge) => {
        const resp = await bridge.waitForResponse(bridge.send('pty.spawn', { cols: 80, rows: 24 }))
        expect(resp.error).toBeUndefined()
      })

      // The live PTY must suppress the idle grace at disconnect; only its own exit re-arms it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(relay.proc.exitCode).toBeNull()

      await relay.waitForExit(5000)
      expect(relay.proc.exitCode).toBe(0)
    },
    20_000
  )

  it.skipIf(process.platform === 'win32')(
    'honors an explicitly configured grace instead of clamping it to the idle cap',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-idle-configured-'))
      const sockPath = path.join(tmpDir, 'relay.sock')
      relay = spawn(['--detached', '--grace-time', '3600', '--sock-path', sockPath], {
        ...process.env,
        ORCA_RELAY_IDLE_GRACE_MS: '200'
      })
      await relay.sentinelReceived

      await connectAndDisconnect(sockPath)

      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(relay.proc.exitCode).toBeNull()
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the relay alive when the client drops while a PTY creation is still in flight',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-idle-inflight-'))
      const daemonEntry = path.join(tmpDir, 'relay.js')
      copyFileSync(relayEntry, daemonEntry)
      writeSlowLoadingNodePty(tmpDir, 1500)
      const sockPath = path.join(tmpDir, 'relay.sock')
      relay = spawnRelayEntry(
        daemonEntry,
        ['--detached', '--grace-time', '0', '--sock-path', sockPath],
        { ...process.env, ORCA_RELAY_IDLE_GRACE_MS: '200' }
      )
      await relay.sentinelReceived

      const bridge = spawn(['--connect', '--sock-path', sockPath])
      await bridge.sentinelReceived
      // Revive, not spawn: it has no client-disconnect abort, so it really does produce a live shell
      // after the parked module load resolves.
      bridge.send('pty.revive', {
        state: JSON.stringify([
          { id: 'pty-restored', pid: process.pid, cols: 80, rows: 24, cwd: tmpDir }
        ])
      })
      // Let the creation park on the module load: it already owns a shell but is not in the pool yet.
      await new Promise((resolve) => setTimeout(resolve, 400))
      bridge.kill('SIGTERM')
      await bridge.waitForExit().catch(() => {})

      // Well past the idle cap and past the point where the parked creation lands in the pool.
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(relay.proc.exitCode).toBeNull()

      const probe = spawn(['--connect', '--sock-path', sockPath])
      try {
        await probe.sentinelReceived
        const status = await probe.waitForResponse(probe.send('relay.status'))
        expect((status.result as { ptys: { active: number } }).ptys.active).toBe(1)
      } finally {
        probe.kill('SIGTERM')
        await probe.waitForExit().catch(() => {})
      }
    },
    20_000
  )

  it.skipIf(process.platform === 'win32')(
    'does not extend an explicitly configured grace when the last PTY exits mid-window',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-configured-rearm-'))
      const { daemon, sockPath } = spawnIdleGraceDaemon(selfExitingNodePtyModule(2500), '3', '200')
      relay = daemon
      await relay.sentinelReceived

      await connectAndDisconnect(sockPath, async (bridge) => {
        const resp = await bridge.waitForResponse(bridge.send('pty.spawn', { cols: 80, rows: 24 }))
        expect(resp.error).toBeUndefined()
      })

      // The 3s window keeps governing; re-arming at the ~2.5s PTY exit would push shutdown past 5s.
      await relay.waitForExit(4200)
      expect(relay.proc.exitCode).toBe(0)
    },
    20_000
  )

  it.skipIf(process.platform === 'win32')(
    're-arms grace after a shutdown deferred by a rejected kill, so the relay still exits',
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-shutdown-deferred-'))
      const { daemon, sockPath } = spawnIdleGraceDaemon(
        KILL_REJECTS_FIRST_DISPOSE_MODULE,
        '2',
        '200'
      )
      relay = daemon
      await relay.sentinelReceived

      await connectAndDisconnect(sockPath, async (bridge) => {
        const resp = await bridge.waitForResponse(bridge.send('pty.spawn', { cols: 80, rows: 24 }))
        expect(resp.error).toBeUndefined()
      })

      // First grace expiry hits the refused kill; only the re-armed window can retry it.
      await relay.waitForExit(8000)
      expect(relay.proc.exitCode).toBe(0)
    },
    20_000
  )

  it('reports relay diagnostics over relay.status', async () => {
    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('relay.status')
    const resp = await relay.waitForResponse(id)
    expect(resp.error).toBeUndefined()
    const status = resp.result as {
      pid: number
      memory: { rss: number }
      ptys: { active: number }
      socket: { owned: boolean; listening: boolean; clients: number }
    }
    expect(status.pid).toBeGreaterThan(0)
    expect(status.memory.rss).toBeGreaterThan(0)
    expect(status.ptys.active).toBe(0)
    expect(status.socket).toMatchObject({ owned: true, listening: true, clients: 0 })
  }, 10_000)

  it('session.registerRoot request returns ok acknowledgment', async () => {
    // Why: session.registerRoot is a protocol-level no-op since the FS
    // allowlist removal, but the request form still must reply { ok: true }
    // for back-compat with mains during the upgrade window. See
    // docs/relay-fs-allowlist-removal.md.
    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('session.registerRoot', { rootPath: '/tmp/anything' })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
  }, 10_000)

  it('reads files outside any registered root', async () => {
    // Regression test for the architecture change in docs/relay-fs-allowlist-removal.md:
    // the relay no longer enforces a workspace allowlist.
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'relay-outside-'))
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'visible')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.readFile', { filePath: path.join(outsideDir, 'secret.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeUndefined()
    expect((resp.result as { content: string }).content).toBe('visible')

    await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  }, 10_000)

  it('reads files via symlinks resolving outside the workspace', async () => {
    // Regression test for issue #1661: a symlink under the workspace pointing
    // to a directory outside it must resolve transparently. The pre-removal
    // relay rejected this with "Path outside authorized workspace".
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'relay-outside-'))
    writeFileSync(path.join(outsideDir, 'data.txt'), 'symlinked-target')
    const { symlinkSync } = require('node:fs')
    symlinkSync(outsideDir, path.join(tmpDir, 'link'))

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.readFile', {
      filePath: path.join(tmpDir, 'link', 'data.txt')
    })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeUndefined()
    expect((resp.result as { content: string }).content).toBe('symlinked-target')

    await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  }, 10_000)

  it('resolves ~ to home directory via session.resolveHome', async () => {
    relay = spawn()
    await relay.sentinelReceived

    const homeDir = require('node:os').homedir()

    const id1 = relay.send('session.resolveHome', { path: '~' })
    const id2 = relay.send('session.resolveHome', { path: '~/projects' })
    const id3 = relay.send('session.resolveHome', { path: '/absolute/path' })

    const [r1, r2, r3] = await Promise.all([
      relay.waitForResponse(id1),
      relay.waitForResponse(id2),
      relay.waitForResponse(id3)
    ])

    expect((r1.result as { resolvedPath: string }).resolvedPath).toBe(homeDir)
    expect((r2.result as { resolvedPath: string }).resolvedPath).toBe(
      path.join(homeDir, 'projects')
    )
    expect((r3.result as { resolvedPath: string }).resolvedPath).toBe('/absolute/path')
  }, 10_000)
})
