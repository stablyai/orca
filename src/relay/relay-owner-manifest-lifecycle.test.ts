// End-to-end proof that a detached relay publishes its owner manifest on listen and takes it down
// with itself — the contract the client's orphan recovery depends on. Spawns the real bundled relay
// rather than importing it, because relay.ts runs main() on import and exports nothing.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseRelayOwnerManifest } from '../shared/relay-owner-manifest'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'

const RELAY_TS_ENTRY = resolve(__dirname, 'relay.ts')
const GENERATION = 'a'.repeat(64)
const SUCCESSOR_GENERATION = 'b'.repeat(64)
const describePosix = process.platform === 'win32' ? describe.skip : describe

let bundleDir: string
let relayEntry: string
let socketDir: string
const spawned: RelayProcess[] = []

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'relay-owner-bundle-'))
  relayEntry = join(bundleDir, 'relay.js')
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
}, 60_000)

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
})

function sockPath(): string {
  return join(socketDir, 'relay.sock')
}

function manifestPath(): string {
  return `${sockPath()}.owner`
}

function launch(args: string[]): RelayProcess {
  const relay = spawnRelay(relayEntry, [
    '--detached',
    '--grace-time',
    '0',
    '--sock-path',
    sockPath(),
    '--endpoint-dir',
    join(socketDir, 'agent-hooks'),
    ...args
  ])
  spawned.push(relay)
  return relay
}

async function waitForFile(path: string, present: boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path) === present) {
      return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${path} to be ${present ? 'present' : 'absent'}`)
}

beforeAll(() => {
  socketDir = mkdtempSync(join(tmpdir(), 'relay-owner-sock-'))
})

afterEach(async () => {
  for (const relay of spawned.splice(0)) {
    relay.kill('SIGKILL')
    await relay.waitForExit(5_000).catch(() => null)
  }
  rmSync(socketDir, { recursive: true, force: true })
  socketDir = mkdtempSync(join(tmpdir(), 'relay-owner-sock-'))
})

describePosix('detached relay owner manifest', () => {
  it('publishes a 0600 manifest naming its own pid, socket and generation', async () => {
    const relay = launch(['--owner-token', GENERATION])
    await waitForFile(manifestPath(), true)

    const manifest = parseRelayOwnerManifest(readFileSync(manifestPath(), 'utf8'))
    const socketStat = statSync(sockPath(), { bigint: true })
    expect(manifest).toEqual({
      generation: GENERATION,
      pid: relay.proc.pid,
      socketPath: sockPath(),
      socketDev: Number(socketStat.dev),
      socketIno: Number(socketStat.ino),
      socketCtimeSeconds: Number(socketStat.ctimeNs / 1_000_000_000n)
    })
    expect(lstatSync(manifestPath()).mode & 0o777).toBe(0o600)
  }, 20_000)

  it('publishes no manifest when the launch carries no owner token', async () => {
    // Why: the sentinel is written at the end of main(), after the publication point — so its
    // arrival, not a sleep, is what proves the relay chose not to publish.
    const relay = launch([])
    await relay.sentinelReceived
    expect(existsSync(sockPath())).toBe(true)
    expect(existsSync(manifestPath())).toBe(false)
  }, 20_000)

  it('removes its manifest and socket on SIGTERM', async () => {
    const relay = launch(['--owner-token', GENERATION])
    await waitForFile(manifestPath(), true)

    relay.kill('SIGTERM')
    await relay.waitForExit(10_000)

    await waitForFile(manifestPath(), false)
    expect(existsSync(sockPath())).toBe(false)
  }, 20_000)

  it('fails closed and leaves no socket behind when the manifest cannot be published', async () => {
    // A directory at the manifest path makes the atomic rename fail without touching the socket path.
    mkdirSync(manifestPath())
    const relay = launch(['--owner-token', GENERATION])

    expect(await relay.waitForExit(10_000)).toBe(1)
    expect(existsSync(sockPath())).toBe(false)
    expect(lstatSync(manifestPath()).isDirectory()).toBe(true)
  }, 20_000)

  it('fails closed on a malformed owner token', async () => {
    const relay = launch(['--owner-token', 'not-a-generation-token'])

    expect(await relay.waitForExit(10_000)).toBe(1)
    expect(existsSync(sockPath())).toBe(false)
    expect(existsSync(manifestPath())).toBe(false)
  }, 20_000)

  it("leaves a live relay's socket and manifest untouched when a duplicate is refused", async () => {
    const live = launch(['--owner-token', GENERATION])
    await live.sentinelReceived
    const liveManifest = readFileSync(manifestPath(), 'utf8')
    const liveSocketIno = statSync(sockPath(), { bigint: true }).ino

    // Why: the duplicate loses the bind and exits 1; its startup catch must clean only its own
    // artifacts, and it owns none.
    const duplicate = launch(['--owner-token', SUCCESSOR_GENERATION])
    expect(await duplicate.waitForExit(10_000)).toBe(1)

    expect(readFileSync(manifestPath(), 'utf8')).toBe(liveManifest)
    expect(statSync(sockPath(), { bigint: true }).ino).toBe(liveSocketIno)
    expect(parseRelayOwnerManifest(liveManifest)?.pid).toBe(live.proc.pid)
  }, 30_000)

  it('lets a successor generation replace a crashed predecessor manifest', async () => {
    const first = launch(['--owner-token', GENERATION])
    await waitForFile(manifestPath(), true)
    first.kill('SIGKILL')
    await first.waitForExit(10_000)
    // The crashed relay left both artifacts behind; the manifest still names the dead generation.
    expect(parseRelayOwnerManifest(readFileSync(manifestPath(), 'utf8'))?.generation).toBe(
      GENERATION
    )

    const second = launch(['--owner-token', SUCCESSOR_GENERATION])
    await second.sentinelReceived

    const manifest = parseRelayOwnerManifest(readFileSync(manifestPath(), 'utf8'))
    expect(manifest?.generation).toBe(SUCCESSOR_GENERATION)
    expect(manifest?.pid).toBe(second.proc.pid)
    expect(manifest?.socketIno).toBe(Number(statSync(sockPath(), { bigint: true }).ino))
  }, 30_000)
})
