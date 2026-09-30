import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnForStablePane } from '../ipc/pty/pane/stable-owner'
import { probeDaemonEndpoint } from './daemon-endpoint-verdict'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

const LEGACY = 35

// Why a child: only a process whose event loop never runs leaves its accept queue full, like a
// daemon wedged in a synchronous call. Atomics.wait blocks without spinning a core.
const WEDGED_LISTENER = `
const server = require('node:net').createServer()
server.listen({ path: process.argv[1], backlog: 1 }, () => {
  process.stdout.write('listening\\n', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
  })
})
`

async function connectOutcome(socketPath: string, held: Socket[]): Promise<string | null> {
  return await new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.once('connect', () => {
      held.push(socket)
      resolve(null)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'))
  })
}

describe.skipIf(process.platform === 'win32')('a live daemon whose accept queue is full', () => {
  let runtimeDir: string
  let socketPath: string
  let listener: ChildProcess | null = null
  const held: Socket[] = []
  const adapters: DaemonPtyAdapter[] = []

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    for (const socket of held.splice(0)) {
      socket.destroy()
    }
    await stopListener()
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  async function stopListener(): Promise<void> {
    const child = listener
    listener = null
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
  }

  /** Returns the error the kernel gives once the queue is full: the positive control. */
  async function startWedgedDaemon(): Promise<string | null> {
    runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-full-queue-'))
    socketPath = getDaemonSocketPath(runtimeDir, LEGACY)
    const child = spawn(process.execPath, ['-e', WEDGED_LISTENER, socketPath], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    listener = child
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => reject(new Error('wedged listener exited early')))
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('listening')) {
          resolve()
        }
      })
    })
    writeFileSync(
      getDaemonPidPath(runtimeDir, LEGACY),
      JSON.stringify({ pid: child.pid, startedAtMs: null, launchNonce: 'wedged' })
    )
    writeFileSync(getDaemonTokenPath(runtimeDir, LEGACY), 'legacy-token')
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const refusal = await connectOutcome(socketPath, held)
      if (refusal) {
        return refusal
      }
    }
    return null
  }

  function legacyAdapter(): DaemonPtyAdapter {
    const adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath: getDaemonTokenPath(runtimeDir, LEGACY),
      pidPath: getDaemonPidPath(runtimeDir, LEGACY),
      protocolVersion: LEGACY
    })
    adapters.push(adapter)
    return adapter
  }

  function restorePane(provider: DaemonPtyAdapter): ReturnType<typeof spawnForStablePane> {
    return spawnForStablePane({
      runtime: undefined,
      provider,
      owner: {
        tabId: 'tab-1',
        leafId: 'leaf-1',
        ptyId: 'wt-1@@0a1b2c3d',
        hasPersistedBinding: true
      },
      spawnOptions: { sessionId: 'wt-1@@0a1b2c3d', cols: 80, rows: 24 }
    })
  }

  it.runIf(process.platform === 'darwin')('is refused by macOS, like an exited one', async () => {
    expect(await startWedgedDaemon()).toBe('ECONNREFUSED')
  })

  it('keeps the version in the startup census', async () => {
    expect(await startWedgedDaemon()).not.toBeNull()

    const kept = await createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))
    adapters.push(...kept)

    expect(kept.map((adapter) => adapter.protocolVersion)).toEqual([LEGACY])
  })

  it('leaves a pane reattaching to it unverified rather than reporting its daemon exited', async () => {
    expect(await startWedgedDaemon()).not.toBeNull()
    const adapter = legacyAdapter()

    await expect(restorePane(adapter)).rejects.toThrow('terminal_pane_owner_unverified')
    await expect(adapter.listProcesses()).rejects.toBeDefined()
  })

  it('reads the version as exited once its recorded process is gone', async () => {
    expect(await startWedgedDaemon()).not.toBeNull()
    for (const socket of held.splice(0)) {
      socket.destroy()
    }
    await stopListener()
    const adapter = legacyAdapter()

    await expect(restorePane(adapter)).rejects.toThrow('terminal_host_gone')
    await expect(adapter.listProcesses()).resolves.toEqual([])
    expect(await createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))).toEqual([])
    // The census reclaimed the dead record; its absence still reads as exited.
    expect(existsSync(getDaemonPidPath(runtimeDir, LEGACY))).toBe(false)
    await expect(
      probeDaemonEndpoint(socketPath, getDaemonPidPath(runtimeDir, LEGACY))
    ).resolves.toEqual({ status: 'exited' })
  })

  // The crash left its socket file and pid record; the pid now names an unrelated live process.
  it('reads a crashed version as exited when its record predates the last boot', async () => {
    expect(await startWedgedDaemon()).not.toBeNull()
    for (const socket of held.splice(0)) {
      socket.destroy()
    }
    await stopListener()
    const pidPath = getDaemonPidPath(runtimeDir, LEGACY)
    const bootedAtMs = Date.now() - uptime() * 1000
    const recordFor = (startedAtMs: number): string =>
      JSON.stringify({ pid: process.pid, startedAtMs, launchNonce: 'crashed' })

    writeFileSync(pidPath, recordFor(bootedAtMs - 60 * 60_000))
    await expect(probeDaemonEndpoint(socketPath, pidPath)).resolves.toEqual({ status: 'exited' })

    writeFileSync(pidPath, recordFor(Date.now() - process.uptime() * 1000))
    await expect(probeDaemonEndpoint(socketPath, pidPath)).resolves.toMatchObject({
      status: 'unverifiable'
    })
  })
})
